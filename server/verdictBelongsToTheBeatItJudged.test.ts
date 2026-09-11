import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * SEVEN APPROVALS THAT PRODUCED NOTHING.
 *
 * Render 578, video 577 re-rendered with every retrieval lever working — 2479 YouTube candidates
 * found against 215 the render before, 88 downloaded against 17, 27 download slots refunded,
 * 16/16 curated records re-attributed:
 *
 *     [ProviderFunnel] provider=youtube_cc judged=23 fits=7 refused=16 accepted=30%
 *     visionAccepted=17   eligible=10   adopted=10
 *     s1b4 visionAccepted=2 eligible=0 adopted=0   -> placeholder
 *     s1b5 visionAccepted=3 eligible=0 adopted=0   -> placeholder
 *     s1b6 visionAccepted=3 eligible=0 adopted=0   -> placeholder
 *     [AdoptionGuard] eligible=true vision=NOT_ASKED blocked=FUNNEL_WITHOUT_EVIDENCE
 *
 * Not one YouTube clip reached the film. The three beats holding eight approvals between them
 * became placeholders and fell to the unregistered topical stock tier — which is how 47.6% of a
 * documentary about 1945 became a modern security van.
 *
 * `[EligibilityGap]` fired ZERO times, so the missing half was never the registration. It was the
 * verdict, and it was missing because the asker and the reader used different keys.
 */

const SRC = readFileSync(join(__dirname, "beatVisualRelevance.ts"), "utf8");

function sliceOf(from: string, to: string): string {
  const a = SRC.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = SRC.indexOf(to, a);
  expect(b, `end anchor not found: ${to}`).toBeGreaterThan(a);
  return SRC.slice(a, b);
}

describe("the reader's rule", () => {
  it("A VERDICT EARNED ON ANOTHER BEAT IS NOT A VERDICT", () => {
    /**
     * `relevanceVerdictForRenderedAsset` is the reader the adoption guard uses, and it has always
     * held this line. It is not being changed; it is the rule the asker now obeys too.
     */
    const reader = sliceOf("export function relevanceVerdictForRenderedAsset", "const answer = (entry");
    expect(reader).toContain("entry.ctx.sceneIndex === asset.sceneIndex");
    expect(reader).toContain("entry.ctx.beatIndex === asset.beatIndex");
  });
});

describe("the asker now applies it", () => {
  /** Bounded by the first line AFTER the lookup, not by a round number the prose also cites. */
  const asker = () => sliceOf("export async function ensureVerdictBeforeCompose", "const neverLookedAt");

  it("an entry from another beat no longer counts as an existing verdict", () => {
    const body = asker();
    expect(body).toContain("entry.ctx.sceneIndex === params.sceneIndex");
    expect(body).toContain("entry.ctx.beatIndex === params.beatIndex");
  });

  it("THE BEAT-BLIND LOOKUP IS GONE", () => {
    /**
     * The defect in one expression: `byClipPath.get(path) ?? byContentKey.get(key)` took the first
     * entry it found from any beat, answered `already_judged`, and never asked. The guard then read
     * NOT_ASKED for the same clip a few lines later.
     */
    const body = asker();
    expect(body).not.toContain("scope.ledger.byClipPath.get(params.clipPath) ??");
  });

  it("both lookups are filtered, not just the path one", () => {
    // A clip found by content key from another beat is exactly as wrong as one found by path.
    const body = asker();
    expect(body).toContain("onThisBeat(byPath) ? byPath : onThisBeat(byKey) ? byKey : undefined");
  });

  it("a `file:` key still never matches across clips", () => {
    /** A path-and-size key is not an identity — the existing rule, untouched. */
    expect(asker()).toContain('!params.contentKey.startsWith("file:")');
  });

  it("A CALLER THAT NAMES NO BEAT KEEPS THE OLD BEHAVIOUR", () => {
    /**
     * `sceneIndex` and `beatIndex` are optional on this call — the compose barrier does not know
     * them. Demanding a match there would refuse every verdict it has, which is the RONDE 199b
     * `askImpossible` lesson: a requirement that cannot be met does not raise the standard, it
     * empties the film.
     */
    const body = asker();
    expect(body).toContain("if (params.sceneIndex == null || params.beatIndex == null) return true;");
  });
});

describe("what did NOT change", () => {
  it("RONDE 228's `somebody has to have looked` test still runs", () => {
    /**
     * The other half of this cache's correctness: an entry written by `pass()` records that nobody
     * looked, and must not satisfy a caller about to USE the picture. That test reads whatever this
     * lookup found and is untouched.
     */
    expect(SRC).toContain("const neverLookedAt = existing.decision.evaluated === false;");
    expect(SRC).toContain("params.finalSay === true && !scope.ledger.finalSayRetried.has(params.clipPath)");
  });

  it("the retry stays bounded at one per clip per render", () => {
    // A genuinely unjudgeable clip costs one extra look, not a loop.
    expect(SRC).toContain("scope.ledger.finalSayRetried.add(params.clipPath);");
  });

  it("NO VERDICT WAS LOOSENED", () => {
    /**
     * This makes the gate ask more often, never accept more. The verdict vocabulary and what each
     * verdict is worth live in `adoptionPolicy`, and nothing here touches them.
     */
    const policy = readFileSync(join(__dirname, "adoptionPolicy.ts"), "utf8");
    expect(policy).toContain("if (visionAvailable && !visionRequirementMet(policy, input.vision)) {");
    expect(policy).toContain('code: "FUNNEL_WITHOUT_EVIDENCE"');
  });

  it("the guard still asks with finalSay before it judges", () => {
    // RONDE 215's last look is what makes the new ask actually happen at the deciding moment.
    const pipe = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");
    /** The ADOPTION GUARD's call — the compose barrier makes its own, without a beat. */
    const at = pipe.indexOf('route: "adoption_guard"');
    expect(at).toBeGreaterThan(0);
    const call = pipe.slice(pipe.lastIndexOf("ensureVerdictBeforeCompose({", at), pipe.indexOf("});", at));
    expect(call).toContain("finalSay: true");
    expect(call).toContain("sceneIndex,");
    expect(call).toContain("beatIndex,");
  });
});
