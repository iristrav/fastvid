/**
 * RONDE 93/94 — THE GUARD MOVED TO WHERE A PICTURE ACTUALLY ENTERS THE FILM, AND WAS SWITCHED ON.
 *
 * ── What RONDE 92 established, and why it blocked the round ─────────────────────────────────
 *
 *     if (await pushClip(withText, sec)) {
 *       recordClipAdopt(..., source, ...);
 *     }
 *
 * `recordClipAdopt` is the only place that knows the adopt route, and it runs AFTER the push. By
 * then `clips.push(clipPath)` has happened and the picture is in the montage. Refusing there
 * refuses a RECORD, not a PICTURE — which is precisely the failure this round's definition of done
 * forbids: "een kandidaat die policy-technisch niet mag worden geadopteerd mag fysiek NIET eerst in
 * clips[] terechtkomen om vervolgens alleen administratief als rejected te worden geregistreerd."
 *
 * ── Why the route's intent is ambient ───────────────────────────────────────────────────────
 *
 * The four `pushSceneClip` variants take `(clipPath, holdSec, beatIndex)`. Threading the adopt
 * route into them means changing the `pushClip` callback signature that dozens of sites pass
 * around. So the route states its intent the way this file already states a beat's provenance
 * (`withBeatProvenance`), its query scope (`withQueryScope`) and its planned shot
 * (`withPlannedShot`) — ambiently, around the work — and the push reads it.
 *
 * A route that states nothing yields null and passes exactly as before. That is what makes this
 * incremental rather than a flag day: no route can be broken by a rule it has not joined yet.
 *
 * ── The two refusals are not the same kind of thing ─────────────────────────────────────────
 *
 * UNDECLARED_ADOPT_ROUTE is unconditional and live. Every label the pipeline actually produces is
 * declared — a structural test walks the call sites, a behavioural one covers the runtime
 * producers — so this refusal has no legitimate traffic to break.
 *
 * FUNNEL_WITHOUT_EVIDENCE is the rule the round is ultimately for. RONDE 93 shipped it behind
 * `ENFORCE_FUNNEL_ADOPTION`, off by default, because `ELIGIBLE` was written at two sites while 35
 * routes adopted: switching it on then would have refused nearly every adoption, driven
 * `verifiedOwnVisual` to zero and made RONDE 89's export gate reject every render.
 *
 * RONDE 94 removed that reason rather than waiting it out. `beatClipPassesVisionGate` — which every
 * rescue and adoption route funnels through — now records eligibility centrally, so the two write
 * sites became one central one covering all of them, and the default inverts: production is strict
 * and `ENFORCE_FUNNEL_ADOPTION=false` is the explicit opt-out a test or an incident can use.
 *
 * The vision requirement got sharper in the same round. RONDE 93 asked whether a verdict EXISTED;
 * the gate's vocabulary is `fits | does_not_fit | unknown`, so a picture the editor had just
 * REFUSED satisfied it. Only APPROVED does now, and the three failing states are distinguishable so
 * a refusal can say which one it was.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  adoptionGuardVerdict,
  currentAdoptionIntent,
  funnelAdoptionEnforced,
  visionVerdictFromGate,
  withAdoptionIntent,
} from "./adoptionPolicy";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

const ENV = "ENFORCE_FUNNEL_ADOPTION";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/* ═══════════════ the intent scope ═══════════════ */

describe("a route can state what it is adopting", () => {
  it("is null outside any intent", () => {
    expect(currentAdoptionIntent()).toBeNull();
  });

  it("carries the label through the push", () => {
    const seen = withAdoptionIntent("archive", () => currentAdoptionIntent());
    expect(seen).toBe("archive");
  });

  it("does not leak past its own call", () => {
    withAdoptionIntent("archive", () => undefined);
    expect(currentAdoptionIntent()).toBeNull();
  });

  /** An empty label is no claim at all and must not open a scope that means "undeclared". */
  it("an empty label opens no scope", () => {
    expect(withAdoptionIntent("", () => currentAdoptionIntent())).toBeNull();
    expect(withAdoptionIntent(undefined, () => currentAdoptionIntent())).toBeNull();
  });

  it("a nested intent wins for the inner work", () => {
    const inner = withAdoptionIntent("archive", () =>
      withAdoptionIntent("rescue_archive", () => currentAdoptionIntent())
    );
    expect(inner).toBe("rescue_archive");
  });
});

/* ═══════════════ the verdict ═══════════════ */

describe("the montage guard refuses only what it can justify refusing", () => {
  const verdict = (over: Partial<Parameters<typeof adoptionGuardVerdict>[0]> = {}) =>
    adoptionGuardVerdict({ source: "archive", eligible: true, vision: "APPROVED", ...over });

  /** A route that stated nothing is the pre-RONDE-93 world, and must behave exactly as before. */
  it("passes when no route stated an intent", () => {
    expect(verdict({ source: null, eligible: false, vision: "NOT_ASKED" }).allowed).toBe(true);
  });

  /** UNCONDITIONAL. No flag, no measurement — there is no legitimate undeclared traffic. */
  it("blocks an undeclared route with the flag off", () => {
    process.env[ENV] = "false";
    const v = verdict({ source: "route_nobody_declared" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("UNDECLARED_ADOPT_ROUTE");
    expect(v.allowed === false && v.reason).toContain("route_nobody_declared");
  });

  it("still blocks it with the flag on", () => {
    process.env[ENV] = "true";
    expect(verdict({ source: "route_nobody_declared" }).allowed).toBe(false);
  });

  /**
   * RONDE 94 — THE DEFAULT ITSELF IS THE ASSERTION.
   *
   * With no environment variable set at all, production is strict. A regression that returns this
   * to "opt in" would make every check below pass while enforcing nothing, so it is checked
   * separately from any behaviour that depends on it.
   */
  it("is enforced when nothing is configured", () => {
    delete process.env[ENV];
    expect(funnelAdoptionEnforced()).toBe(true);
  });

  it("only the explicit string \"false\" turns it off", () => {
    process.env[ENV] = "false";
    expect(funnelAdoptionEnforced()).toBe(false);
    process.env[ENV] = "0";
    expect(funnelAdoptionEnforced()).toBe(true);
    process.env[ENV] = "";
    expect(funnelAdoptionEnforced()).toBe(true);
  });

  /** VID-0568 CASE 2 and 3: unbacked funnel claims, which the opt-out still lets through. */
  it("lets an unbacked funnel claim through only when explicitly disabled", () => {
    process.env[ENV] = "false";
    expect(funnelAdoptionEnforced()).toBe(false);
    expect(verdict({ source: "wikimedia", eligible: false, vision: "APPROVED" }).allowed).toBe(true);
    expect(verdict({ source: "wikimedia", eligible: true, vision: "NOT_ASKED" }).allowed).toBe(true);
  });

  it("blocks a funnel claim with no eligibility once enforced", () => {
    delete process.env[ENV];
    const v = verdict({ source: "wikimedia", eligible: false, vision: "APPROVED" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
    expect(v.allowed === false && v.reason).toContain("eligibility");
  });

  it("blocks a funnel claim with no vision once enforced", () => {
    delete process.env[ENV];
    const v = verdict({ source: "wikimedia", eligible: true, vision: "NOT_ASKED" });
    expect(v.allowed === false && v.reason).toContain("vision");
  });

  it("names both when both are missing", () => {
    delete process.env[ENV];
    const v = verdict({ source: "archive", eligible: false, vision: "NOT_ASKED" });
    expect(v.allowed === false && v.reason).toContain("eligibility and vision");
  });

  /**
   * RONDE 94 — THE IMPLICIT APPROVAL, REMOVED.
   *
   * These three are the whole reason the boolean became a verdict. Under RONDE 93 every one of
   * them counted as "judged" and adopted as REAL_FUNNEL: a picture the editor had refused, a
   * picture it could not read, and — through the same branch — one nobody had shown it.
   */
  it("a REFUSED picture cannot claim the funnel", () => {
    delete process.env[ENV];
    const v = verdict({ source: "archive", eligible: true, vision: "REJECTED" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("REJECTED");
  });

  it("an UNCLEAR picture cannot claim the funnel", () => {
    delete process.env[ENV];
    const v = verdict({ source: "archive", eligible: true, vision: "UNCLEAR" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("UNCLEAR");
  });

  it("a NOT_ASKED picture cannot claim the funnel", () => {
    delete process.env[ENV];
    const v = verdict({ source: "archive", eligible: true, vision: "NOT_ASKED" });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("NOT_ASKED");
  });

  /** The gate's own words, translated once. A verdict this does not know is not an approval. */
  it("translates the picture gate's vocabulary without inventing an approval", () => {
    expect(visionVerdictFromGate("fits")).toBe("APPROVED");
    expect(visionVerdictFromGate("does_not_fit")).toBe("REJECTED");
    expect(visionVerdictFromGate("unknown")).toBe("UNCLEAR");
    expect(visionVerdictFromGate(null)).toBe("NOT_ASKED");
    expect(visionVerdictFromGate(undefined)).toBe("NOT_ASKED");
    expect(visionVerdictFromGate("something_new")).toBe("NOT_ASKED");
  });

  /** A fully backed funnel adoption is exactly what the pipeline should be producing. */
  it("allows a backed funnel claim when enforced", () => {
    delete process.env[ENV];
    expect(verdict({ source: "archive", eligible: true, vision: "APPROVED" }).allowed).toBe(true);
  });

  /** RESCUE is exempt from eligibility BY DECLARATION, and must not light up when enforced. */
  it("a declared rescue passes without eligibility even when enforced", () => {
    delete process.env[ENV];
    expect(
      verdict({ source: "rescue_wikimedia", eligible: false, vision: "APPROVED" }).allowed
    ).toBe(true);
  });

  it("but a rescue still needs the picture approved, not merely looked at", () => {
    delete process.env[ENV];
    expect(
      verdict({ source: "rescue_wikimedia", eligible: false, vision: "NOT_ASKED" }).allowed
    ).toBe(false);
    expect(
      verdict({ source: "rescue_wikimedia", eligible: false, vision: "REJECTED" }).allowed
    ).toBe(false);
  });

  /** A placeholder requires neither and must never be refused for lacking them. */
  it("a placeholder passes with no evidence at all", () => {
    delete process.env[ENV];
    expect(verdict({ source: "fallback", eligible: false, vision: "NOT_ASKED" }).allowed).toBe(true);
    expect(verdict({ source: "guaranteed", eligible: false, vision: "NOT_ASKED" }).allowed).toBe(true);
  });
});

/* ═══════════════ and it sits before clips.push, not after ═══════════════ */

describe("the guard runs at the montage boundary", () => {
  it("every pushSceneClip variant consults it", () => {
    const variants = [...PIPE.matchAll(/const pushSceneClip = async \(/g)];
    expect(variants.length).toBeGreaterThanOrEqual(4);
    const calls = [...PIPE.matchAll(/adoptionGuardRefusesPush\(dedup, clipPath, scene\.index, beatIndex\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(variants.length);
  });

  /**
   * THE WHOLE POINT. If the guard ever moves after `clips.push`, a refused candidate is in the
   * montage and only its paperwork was rejected — the exact thing RONDE 92 found and this round
   * exists to fix.
   */
  it("is checked before the clip enters clips[]", () => {
    for (const m of PIPE.matchAll(/const pushSceneClip = async \(/g)) {
      const body = PIPE.slice(m.index!, PIPE.indexOf("\n  };", m.index!));
      const guard = body.indexOf("adoptionGuardRefusesPush(");
      const push = body.indexOf("clips.push(clipPath)");
      if (push < 0) continue;
      expect(guard, "a pushSceneClip variant does not consult the guard").toBeGreaterThan(-1);
      expect(guard, "the guard runs after the clip is already in the montage").toBeLessThan(push);
    }
  });

  /** A refusal is a terminal outcome, not a silent disappearance. */
  it("records the refusal on the ledger and the beat audit", () => {
    const at = PIPE.indexOf("async function adoptionGuardRefusesPush(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(body).toContain("recordClipReject(");
    expect(body).toContain("recordRejection(");
    expect(body).toContain("tracePushOutcome(");
    expect(body).toContain("[AdoptionGuard]");
  });

  /**
   * It reads eligibility from the ledger, following derivations — not from the filename.
   *
   * RONDE 94 moved the resolve-then-hasStage pair behind `VisualSourceLedger.isEligible`, because
   * PHASE 3 requires ONE central read that every enforcement decision shares. So the assertion
   * moves with it: the guard must call that helper, and the helper itself must still resolve
   * through the derivation chain and ask `hasStage` rather than matching a name.
   */
  it("asks the ledger for eligibility through the one central helper", () => {
    const at = PIPE.indexOf("async function adoptionGuardRefusesPush(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(body).toContain("isEligible(clipPath, clipContentKey(clipPath))");
    expect(body).toContain("relevanceVerdictForRenderedAsset(");
    /** And it acts on WHAT was said, not merely that something was. */
    expect(body).toContain("visionVerdictFromGate(");

    const LEDGER = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");
    const helper = LEDGER.slice(LEDGER.indexOf("  isEligible(clipPath: string"));
    const impl = helper.slice(0, helper.indexOf("\n  }"));
    expect(impl).toContain("this.resolve(clipPath, contentKey)");
    expect(impl).toContain('this.hasStage(record.lineageId, "ELIGIBLE")');
  });

  /**
   * RONDE 94 PHASE 3 — and nobody may go round it.
   *
   * The point of a central helper is defeated the moment a second route open-codes the same
   * question. `resolve()` + `hasStage(..., "ELIGIBLE")` written out by hand is exactly that second
   * implementation, and it is how the two readings drift apart.
   */
  it("no route open-codes the eligibility question a second time", () => {
    const openCoded = [...PIPE.matchAll(/hasStage\([^)]*,\s*"ELIGIBLE"\)/g)];
    expect(openCoded.length, "eligibility is read through isEligible(), not re-derived").toBe(0);
  });

  /** The archive adopt route is wired, and states the label it already records. */
  it("the archive adopt route declares its intent", () => {
    expect(PIPE).toContain("withAdoptionIntent(adoptIntent, () => pushClip(withText, sec))");
    const at = PIPE.indexOf("const adoptIntent =");
    expect(PIPE.slice(at, at + 200)).toContain('adoptMeta?.source ?? (curated ? "archive" : "archive_fetch")');
  });
});
