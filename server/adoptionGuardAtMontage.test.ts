/**
 * RONDE 93 — THE GUARD MOVED TO WHERE A PICTURE ACTUALLY ENTERS THE FILM.
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
 * FUNNEL_WITHOUT_EVIDENCE is the rule the round is ultimately for, and it is behind
 * `ENFORCE_FUNNEL_ADOPTION`, off by default. Not timidity: RONDE 92 measured that `ELIGIBLE` is
 * written at two sites while 35 routes adopt, so switching it on today would refuse nearly every
 * adoption, drive `verifiedOwnVisual` to zero, and make RONDE 89's export gate reject every render.
 * The flag exists so one production `[AdoptionEvidence]` line decides when it is safe — rather than
 * the first firing being in front of a user.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  adoptionGuardVerdict,
  currentAdoptionIntent,
  funnelAdoptionEnforced,
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
    adoptionGuardVerdict({ source: "archive", eligible: true, judged: true, ...over });

  /** A route that stated nothing is the pre-RONDE-93 world, and must behave exactly as before. */
  it("passes when no route stated an intent", () => {
    expect(verdict({ source: null, eligible: false, judged: false }).allowed).toBe(true);
  });

  /** UNCONDITIONAL. No flag, no measurement — there is no legitimate undeclared traffic. */
  it("blocks an undeclared route with the flag off", () => {
    delete process.env[ENV];
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
   * VID-0568 CASE 2 and 3, as the guard sees them. Both pass today because the flag is off, and
   * both must block the moment it is on — that is the entire point of shipping the switch.
   */
  it("lets an unbacked funnel claim through while the flag is off", () => {
    delete process.env[ENV];
    expect(funnelAdoptionEnforced()).toBe(false);
    expect(verdict({ source: "wikimedia", eligible: false, judged: true }).allowed).toBe(true);
    expect(verdict({ source: "wikimedia", eligible: true, judged: false }).allowed).toBe(true);
  });

  it("blocks a funnel claim with no eligibility once enforced", () => {
    process.env[ENV] = "true";
    const v = verdict({ source: "wikimedia", eligible: false, judged: true });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
    expect(v.allowed === false && v.reason).toContain("eligibility");
  });

  it("blocks a funnel claim with no vision once enforced", () => {
    process.env[ENV] = "true";
    const v = verdict({ source: "wikimedia", eligible: true, judged: false });
    expect(v.allowed === false && v.reason).toContain("vision");
  });

  it("names both when both are missing", () => {
    process.env[ENV] = "true";
    const v = verdict({ source: "archive", eligible: false, judged: false });
    expect(v.allowed === false && v.reason).toContain("eligibility and vision");
  });

  /** A fully backed funnel adoption is exactly what the pipeline should be producing. */
  it("allows a backed funnel claim when enforced", () => {
    process.env[ENV] = "true";
    expect(verdict({ source: "archive", eligible: true, judged: true }).allowed).toBe(true);
  });

  /** RESCUE is exempt from eligibility BY DECLARATION, and must not light up when enforced. */
  it("a declared rescue passes without eligibility even when enforced", () => {
    process.env[ENV] = "true";
    expect(verdict({ source: "rescue_wikimedia", eligible: false, judged: true }).allowed).toBe(true);
  });

  it("but a rescue still needs the picture judged", () => {
    process.env[ENV] = "true";
    expect(verdict({ source: "rescue_wikimedia", eligible: false, judged: false }).allowed).toBe(false);
  });

  /** A placeholder requires neither and must never be refused for lacking them. */
  it("a placeholder passes with no evidence at all", () => {
    process.env[ENV] = "true";
    expect(verdict({ source: "fallback", eligible: false, judged: false }).allowed).toBe(true);
    expect(verdict({ source: "guaranteed", eligible: false, judged: false }).allowed).toBe(true);
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

  /** It reads eligibility from the ledger, following derivations — not from the filename. */
  it("asks the ledger for eligibility rather than guessing", () => {
    const at = PIPE.indexOf("async function adoptionGuardRefusesPush(");
    const body = PIPE.slice(at, PIPE.indexOf("\n}", at));
    expect(body).toContain('hasStage(record.lineageId, "ELIGIBLE")');
    expect(body).toContain("relevanceVerdictForRenderedAsset(");
  });

  /** The archive adopt route is wired, and states the label it already records. */
  it("the archive adopt route declares its intent", () => {
    expect(PIPE).toContain("withAdoptionIntent(adoptIntent, () => pushClip(withText, sec))");
    const at = PIPE.indexOf("const adoptIntent =");
    expect(PIPE.slice(at, at + 200)).toContain('adoptMeta?.source ?? (curated ? "archive" : "archive_fetch")');
  });
});
