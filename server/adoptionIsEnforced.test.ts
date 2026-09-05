/**
 * RONDE 94 — THE ROUND THAT STOPPED MEASURING AND STARTED REFUSING.
 *
 * ── What the previous four rounds actually built ────────────────────────────────────────────
 *
 * RONDE 90 wrote down the adoption vocabulary. RONDE 91 made coverage derive from it. RONDE 92
 * added the read side and the `[AdoptionEvidence]` line. RONDE 93 moved the guard to the montage
 * boundary, before `clips.push`, in all five push variants.
 *
 * All of it was correct and none of it was on. Two things kept it off:
 *
 *   1. `ELIGIBLE` was written at two call sites while thirty-five routes adopted, so enforcing
 *      `requiresEligibility` would have refused almost every adoption.
 *   2. One route out of thirty-five declared an adoption intent, so the guard's first line —
 *      `if (!source) return false` — let the other thirty-four past untouched.
 *
 * The measurement RONDE 93 was waiting for would only ever have confirmed both. So RONDE 94 fixes
 * the causes instead: eligibility is recorded centrally at the point every route already passes
 * through, every route states what it is adopting, and the flag defaults to ON.
 *
 * ── What this file is for ───────────────────────────────────────────────────────────────────
 *
 * The behavioural rules live in `adoptionGuardAtMontage.test.ts` beside the guard they describe.
 * This file holds the two things that can only be checked against the SHAPE of the pipeline: that
 * no adoption route escaped the wiring, and that the ways round the gate stayed closed. A rule
 * enforced at one site and forgotten at the next is this codebase's most repeated failure — the
 * doc comments count sixteen instances — and a structural test is the only thing that has ever
 * caught the seventeenth.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  adoptionPolicyFor,
  adoptionGuardVerdict,
  funnelAdoptionEnforced,
} from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const LEDGER = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");
const AUDIT = fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");
const POLICY = fs.readFileSync(path.join(__dirname, "adoptionPolicy.ts"), "utf8");

/* ═══════════════ PHASE 1 — every route says what it is adopting ═══════════════ */

describe("no adoption route reaches the montage undeclared", () => {
  /**
   * THE 34-ROUTE GAP, AS A STANDING CHECK.
   *
   * An adapter that forwards its own caller's arguments (`(clipPath, holdSec) => pushClip(...)`)
   * is deliberately exempt: it hands the push down to a route that declares its own intent, and
   * naming one here would OVERRIDE the accurate inner label with a vaguer outer one. Every other
   * call names a concrete clip and is therefore an adoption decision.
   */
  it("every push that adopts a concrete clip is inside an adoption intent", () => {
    const undeclared: string[] = [];
    for (const m of PIPE.matchAll(/pushClip\(/g)) {
      const i = m.index!;
      const lineStart = PIPE.lastIndexOf("\n", i) + 1;
      const line = PIPE.slice(lineStart, PIPE.indexOf("\n", i));
      if (/const pushClip|pushClip:|pushClip = /.test(line)) continue;
      if (/=>\s*pushClip\(clipPath,/.test(line)) continue;
      if (PIPE.slice(Math.max(0, i - 90), i).includes("withAdoptionIntent(")) continue;
      undeclared.push(`${PIPE.slice(0, i).split("\n").length}: ${line.trim().slice(0, 100)}`);
    }
    expect(undeclared, `undeclared adoption route(s):\n${undeclared.join("\n")}`).toEqual([]);
  });

  /** And the intents that ARE declared must all be labels the policy table knows. */
  it("every declared intent is a label the policy table declares", () => {
    const literals = [...PIPE.matchAll(/withAdoptionIntent\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(12);
    for (const label of new Set(literals)) {
      expect(adoptionPolicyFor(label).category, `route "${label}" is undeclared`).not.toBe(
        "UNDECLARED"
      );
    }
  });

  /**
   * The four labels RONDE 94 had to add, named individually.
   *
   * Three of them (`beat_fetch`, `script_image`, `research_refetch`) are the montage insertions in
   * `fetchSceneVisualsInner` that call no `recordClipAdopt` at all — invisible to every audit the
   * previous rounds built. The fourth is the scene recovery ladder.
   */
  it("the routes that adopted without any audit entry are now declared", () => {
    for (const label of ["beat_fetch", "script_image", "research_refetch"]) {
      expect(adoptionPolicyFor(label).category).toBe("REAL_FUNNEL");
    }
    expect(adoptionPolicyFor("recovered_scene").category).toBe("RESCUE_REAL");
    expect(adoptionPolicyFor("recovered_scene").exceptionReason).toBeTruthy();
  });
});

/* ═══════════════ PHASE 6 — the scene-level ways round the guard ═══════════════ */

describe("the scene-level fill routes cannot bypass the montage boundary", () => {
  /**
   * RONDE 93 guarded the five push closures and stopped there, which was right for the montage
   * path and blind to the other one: `recoverSceneClipsIfEmpty` builds its own `clips` array and
   * the caller assigns it STRAIGHT to `sceneVisualResults[si]`. Nothing in that path ever met a
   * push variant, so a clip could reach the delivered scene without any guard seeing it.
   */
  it("recoverSceneClipsIfEmpty consults the guard at every insertion", () => {
    const at = PIPE.indexOf("async function recoverSceneClipsIfEmptyInner(");
    expect(at).toBeGreaterThan(-1);
    const end = PIPE.indexOf("\nasync function ", at + 10);
    const body = PIPE.slice(at, end);
    const inserts = [...body.matchAll(/clips\.push\(/g)].length;
    const guards = [...body.matchAll(/adoptionGuardRefusesPush\(/g)].length;
    expect(inserts).toBeGreaterThan(0);
    expect(guards, "an insertion in scene recovery is not guarded").toBeGreaterThanOrEqual(inserts);
  });

  /** The fast-short rescue writes into the same delivered structure and gets the same rule. */
  it("the fast stock rescue for an empty scene is guarded", () => {
    const at = PIPE.indexOf("fast stock/guaranteed fill");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 3000);
    const insert = region.indexOf("clips.push(clipPath)");
    const guard = region.indexOf("adoptionGuardRefusesPush(");
    expect(insert).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard, "the guard runs after the clip is already in the scene").toBeLessThan(insert);
  });

  /** The guaranteed scene filler builds clips without a beat and must still declare and be gated. */
  it("the guaranteed scene filler declares its tier and is gated", () => {
    const at = PIPE.indexOf("const guaranteedIntent = guaranteedAdoptSource(tierOut.tier);");
    expect(at).toBeGreaterThan(-1);
    const region = PIPE.slice(at, at + 600);
    expect(region).toContain("adoptionGuardRefusesPush(");
    expect(region.indexOf("adoptionGuardRefusesPush(")).toBeLessThan(region.indexOf("clips.push("));
  });
});

/* ═══════════════ PHASE 2/3 — one writer, one reader, no second registry ═══════════════ */

describe("eligibility has exactly one writer and one reader", () => {
  /**
   * The central write. `beatClipPassesVisionGate`'s own doc says every rescue and adoption route
   * funnels through it — that is precisely why RONDE 94 records eligibility there, one line after
   * the last deterministic veto and one line before the picture costs a judgement.
   */
  it("the vision gate records eligibility for every route that reaches it", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    const mark = body.indexOf("markEligible(clipPath, clipContentKey(clipPath)");
    const judge = body.indexOf("judgeBeatClipRelevance(");
    expect(mark, "the vision gate does not record eligibility").toBeGreaterThan(-1);
    expect(judge).toBeGreaterThan(-1);
    expect(mark, "eligibility is recorded after the judgement it should precede").toBeLessThan(judge);
  });

  /** A veto above it must still refuse before eligibility is claimed. */
  it("a clip with burnt-in text never becomes eligible", () => {
    const at = PIPE.indexOf("async function beatClipPassesVisionGate(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body.indexOf('recordClipReject(dedup.clipRejectAudit, scene.index, beat.index, clipPath, "baked_text"')).toBeLessThan(
      body.indexOf("markEligible(clipPath")
    );
  });

  /**
   * NO SECOND REGISTRY. `VisualSourceLedger` is the only thing that stores the answer, and after
   * RONDE 94 it is also the only thing that spells the question — no route writes the raw stage
   * itself, and no route open-codes the resolve-then-hasStage read.
   */
  it("nothing writes the ELIGIBLE stage outside the ledger's own writer", () => {
    expect([...PIPE.matchAll(/recordEvent\([^)]*"ELIGIBLE"/g)].length).toBe(0);
    expect([...AUDIT.matchAll(/recordEvent\([^)]*"ELIGIBLE"/g)].length).toBe(0);
    const writer = LEDGER.slice(LEDGER.indexOf("  markLineageEligible(lineageId: string"));
    expect(writer.slice(0, writer.indexOf("\n  }"))).toContain('recordEvent(lineageId, "ELIGIBLE"');
  });

  it("no module keeps its own eligibility map", () => {
    for (const [name, src] of [["pipeline", PIPE], ["audit", AUDIT], ["policy", POLICY]] as const) {
      expect(src, `${name} declares a second eligibility store`).not.toMatch(
        /(eligibleByPath|eligibleAssets|eligibilityRegistry|ELIGIBLE_SET)/
      );
    }
  });

  /** Eligibility belongs to the ASSET, so a pad/trim/overlay derivative inherits it. */
  it("the read walks the derivation chain rather than matching a name", () => {
    const at = LEDGER.indexOf("  isEligible(clipPath: string");
    const body = LEDGER.slice(at, LEDGER.indexOf("\n  }", at));
    expect(body).toContain("this.resolve(clipPath, contentKey)");
    expect(body).toContain('this.hasStage(record.lineageId, "ELIGIBLE")');
    expect(body).not.toContain("basename");
  });

  /**
   * And the one rename that used to break the chain is now recorded as a derivation. Without this,
   * enforcement would refuse the pipeline's own work: the gate judges `clipPath`, the overlay
   * writes `withText`, and the guard would ask about a file with no provenance.
   */
  it("the text overlay registers its output as a derived file", () => {
    const at = PIPE.indexOf("async function applyVideoBeatTextOverlay(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}\n", at));
    expect(body).toContain('linkDerivedPath(out, clipPath, "OVERLAYED"');
  });
});

/* ═══════════════ PHASE 7 — production is strict, and only a test may say otherwise ═══════════════ */

describe("enforcement is on unless something explicitly turns it off", () => {
  const ENV = "ENFORCE_FUNNEL_ADOPTION";

  it("no production default disables the gate", () => {
    /** The old opt-in spelling, which is what a regression would restore. */
    expect(POLICY).not.toContain('ENFORCE_FUNNEL_ADOPTION === "true"');
    expect(POLICY).toContain('ENFORCE_FUNNEL_ADOPTION !== "false"');
  });

  it("no shipped config file ships the gate turned off", () => {
    const roots = [path.join(__dirname, ".."), __dirname];
    const suspects: string[] = [];
    for (const root of roots) {
      for (const name of fs.readdirSync(root)) {
        if (!/^(\.env|railway|Dockerfile|docker-compose|nixpacks|Procfile)/i.test(name)) continue;
        const full = path.join(root, name);
        if (!fs.statSync(full).isFile()) continue;
        if (/ENFORCE_FUNNEL_ADOPTION\s*[:=]\s*"?false/i.test(fs.readFileSync(full, "utf8"))) {
          suspects.push(name);
        }
      }
    }
    expect(suspects, `config disables enforcement: ${suspects.join(", ")}`).toEqual([]);
  });

  it("an unset environment enforces", () => {
    const saved = process.env[ENV];
    try {
      delete process.env[ENV];
      expect(funnelAdoptionEnforced()).toBe(true);
      expect(
        adoptionGuardVerdict({ source: "archive", eligible: false, vision: "APPROVED" }).allowed
      ).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  });
});

/* ═══════════════ PHASE 5 — "could not ask" is not "did not ask" ═══════════════ */

describe("an unreachable picture editor suspends one requirement and excuses nothing else", () => {
  const ENV = "ENFORCE_FUNNEL_ADOPTION";
  const enforced = <T,>(fn: () => T): T => {
    const saved = process.env[ENV];
    try {
      delete process.env[ENV];
      return fn();
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  };

  /**
   * The whole reason this exemption exists. `beatClipPassesVisionGate` fails open when the local
   * CLIP model will not load, and the relevance ledger then records `unknown` for every picture in
   * the render. Enforcing the vision requirement there refuses every real adoption for a reason
   * that is not about any picture.
   */
  it("suspends the vision requirement when the model never loaded", () => {
    enforced(() => {
      expect(
        adoptionGuardVerdict({
          source: "archive",
          eligible: true,
          vision: "UNCLEAR",
          visionAvailable: false,
        }).allowed
      ).toBe(true);
    });
  });

  it("still requires eligibility when the model never loaded", () => {
    enforced(() => {
      const v = adoptionGuardVerdict({
        source: "archive",
        eligible: false,
        vision: "UNCLEAR",
        visionAvailable: false,
      });
      expect(v.allowed).toBe(false);
      expect(v.allowed === false && v.reason).toContain("eligibility");
      expect(v.allowed === false && v.reason).not.toContain("vision");
    });
  });

  it("still refuses an undeclared route when the model never loaded", () => {
    enforced(() => {
      const v = adoptionGuardVerdict({
        source: "route_nobody_declared",
        eligible: true,
        vision: "APPROVED",
        visionAvailable: false,
      });
      expect(v.allowed === false && v.code).toBe("UNDECLARED_ADOPT_ROUTE");
    });
  });

  /** THE NARROWNESS IS THE POINT: one unjudged picture in a working render is still refused. */
  it("does not excuse a single unjudged picture in a render whose editor was working", () => {
    enforced(() => {
      for (const vision of ["NOT_ASKED", "REJECTED", "UNCLEAR"] as const) {
        expect(
          adoptionGuardVerdict({ source: "archive", eligible: true, vision }).allowed,
          `${vision} was excused without the model being unavailable`
        ).toBe(false);
      }
    });
  });

  /** Availability is a fact about the process, recorded where it is known and read once. */
  it("the fact is set only by the fail-open branch and read only by the guard", () => {
    const GATE = fs.readFileSync(path.join(__dirname, "visualQualityGate.ts"), "utf8");
    const writes = [...GATE.matchAll(/visionPipelineUnavailable = true/g)];
    expect(writes.length, "more than one place claims the model is unavailable").toBe(1);
    const at = GATE.indexOf("visionPipelineUnavailable = true");
    expect(GATE.slice(Math.max(0, at - 1400), at)).toContain("if (!pipelineReady) {");
    expect(PIPE).toContain("visionPipelineIsUnavailable()");
    /** And it may never be inverted into a reason to SKIP eligibility. */
    const guardAt = PIPE.indexOf("async function adoptionGuardRefusesPush(");
    const guard = PIPE.slice(guardAt, PIPE.indexOf("\n}", guardAt));
    expect(guard).toContain("const visionAvailable = !visionPipelineIsUnavailable();");
    expect(guard).toContain("isEligible(clipPath, clipContentKey(clipPath))");
  });
});

/* ═══════════════ PHASE 27 — VID-0568, case by case ═══════════════ */

describe("the render-568 failures, as standing regressions", () => {
  const ENV = "ENFORCE_FUNNEL_ADOPTION";
  const guard = (over: Partial<Parameters<typeof adoptionGuardVerdict>[0]>) => {
    const saved = process.env[ENV];
    try {
      delete process.env[ENV];
      return adoptionGuardVerdict({
        source: "archive",
        eligible: true,
        vision: "APPROVED",
        ...over,
      });
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  };

  /** `[VisualFunnel] TOTAL retrieved=3995 eligible=4` with 23 adoptions on top of it. */
  it("1 — eligible=0 cannot adopt as REAL_FUNNEL", () => {
    expect(guard({ source: "wikimedia", eligible: false }).allowed).toBe(false);
  });

  /** 15 of 17 beats: `verification=never_asked reason=real_footage_never_judged`. */
  it("2 — a picture nobody judged cannot adopt as REAL_FUNNEL", () => {
    expect(guard({ vision: "NOT_ASKED" }).allowed).toBe(false);
  });

  it("3 — a picture the editor REFUSED cannot adopt as REAL_FUNNEL", () => {
    expect(guard({ vision: "REJECTED" }).allowed).toBe(false);
  });

  it("4 — a picture the editor could not read cannot adopt as REAL_FUNNEL", () => {
    expect(guard({ vision: "UNCLEAR" }).allowed).toBe(false);
  });

  it("5 — eligibility plus an approval does adopt", () => {
    expect(guard({}).allowed).toBe(true);
  });

  /** `UNVERIFIED retrieved=0 eligible=0 adopted=23 finalVideo=17` — the undeclared 17. */
  it("6 — an undeclared route is refused before the montage, flag or no flag", () => {
    const saved = process.env[ENV];
    try {
      for (const value of ["false", "true", undefined]) {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        const v = adoptionGuardVerdict({
          source: "some_route_nobody_declared",
          eligible: true,
          vision: "APPROVED",
        });
        expect(v.allowed).toBe(false);
        expect(v.allowed === false && v.code).toBe("UNDECLARED_ADOPT_ROUTE");
      }
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  });

  /** `guaranteedAdoptSource("wikimedia")` used to return the funnel's own name. */
  it("8 — a Wikimedia rescue is not the Wikimedia funnel", () => {
    expect(adoptionPolicyFor("wikimedia").category).toBe("REAL_FUNNEL");
    expect(adoptionPolicyFor("rescue_wikimedia").category).toBe("RESCUE_REAL");
    expect(adoptionPolicyFor("rescue_wikimedia").countsAsVerifiedVisual).toBe(false);
  });

  /** `subject_fallback ×10` counted as own footage in the coverage reading. */
  it("9 — a subject fallback is real footage but never a verified visual", () => {
    const policy = adoptionPolicyFor("subject_fallback");
    expect(policy.category).toBe("FALLBACK_SUBJECT");
    expect(policy.countsAsRealFootage).toBe(true);
    expect(policy.countsAsVerifiedVisual).toBe(false);
  });

  /** No route may become verified by not being recognised. */
  it("10 — an unknown label is the most conservative reading, never the most generous", () => {
    for (const label of ["", "  ", "primary", "unknown", "definitely_not_a_route"]) {
      const policy = adoptionPolicyFor(label);
      expect(policy.countsAsRealFootage).toBe(false);
      expect(policy.countsAsVerifiedVisual).toBe(false);
    }
  });
});
