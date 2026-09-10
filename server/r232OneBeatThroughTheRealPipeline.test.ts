/**
 * RONDE 232 — ONE BEAT, FOUR CANDIDATES, THROUGH THE PIPELINE'S OWN FUNCTIONS.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────
 *
 * Every round since 223 has proven its fix with tests, and every round has had to end the same
 * sentence: TEST-PROVEN, PRODUCTION-NOT-PROVEN. Railway is unreachable from the build environment,
 * so the chain that actually matters —
 *
 *     beat → intent → query → gate → candidate → eligibility → shortlist → vision →
 *     adoption → lineage → lifecycle
 *
 * — has never been exercised END TO END anywhere. The individual links are each covered; the
 * JOINS between them are not. A render can fail at a join while every link passes its own test,
 * and renders 574, 575 and 576 all did exactly that.
 *
 * This file walks one beat through the REAL functions, in order, and asserts what comes out.
 *
 * ── What is real and what is not ────────────────────────────────────────────────────────────
 *
 * REAL, not simulated: validateSearchQuery (the search gate), VisualSourceLedger (lineage,
 * eligibility, events, lifecycle), admitToShortlist / noteVisionAsked / releaseShortlistSlot
 * (the R230-A bound), visionVerdictFromGate (the verdict vocabulary), adoptionPolicyFor and
 * adoptionGuardVerdict (the guard that decides), preparationKey (the R230-B identity).
 *
 * DETERMINISTIC INPUT, deliberately: what the picture editor says about each clip. That is a
 * model behind a network boundary and the standing rule forbids simulating providers — so this
 * file does not simulate one. It states the verdict as a fact of the scenario, the way a fixture
 * states a file's bytes, and then measures what the pipeline DOES with that verdict. Nothing
 * between the verdict and the montage is faked.
 *
 * ── The scenario ────────────────────────────────────────────────────────────────────────────
 *
 * Beat: "As Soviet forces closed on Berlin in April 1945, Hitler withdrew into the Führerbunker."
 *
 *     A  modern generic        a 2019 drone shot of Berlin        editor: does_not_fit
 *     B  the event itself      Soviet troops, Berlin, 1945        editor: fits
 *     C  subject only          a Hitler portrait, no event        editor: unknown
 *     D  plainly wrong         a beach holiday                    editor: does_not_fit
 *
 * The film wants B. The interesting failures are A and C: a beat about an EVENT can be handed a
 * picture that merely contains the SUBJECT, and render 569 showed what happens when the guard
 * treats "I cannot tell" as a refusal — fourteen beats fell to colour cards.
 */
import { describe, expect, it } from "vitest";

import {
  adoptionGuardVerdict,
  adoptionPolicyFor,
  visionVerdictFromGate,
  withAdoptionIntent,
  currentAdoptionIntent,
  type AdoptionVisionVerdict,
} from "./adoptionPolicy";
import { validateSearchQuery } from "./searchQueryContract";
import { VisualSourceLedger } from "./visualSourceLineage";
import {
  admitToShortlist,
  beatFunnel,
  createBeatShortlistState,
  noteEligible,
  noteVisionAsked,
  releaseShortlistSlot,
} from "./beatShortlist";
import { preparationKey } from "./preparationCache";

const BEAT_TEXT =
  "As Soviet forces closed on Berlin in April 1945, Hitler withdrew into the Führerbunker.";
const SCENE = 1;
const BEAT = 5;
const CAP = 8;

/** What the editor said about each clip. The one deterministic input; see the header. */
type EditorWord = "fits" | "does_not_fit" | "unknown";

type Candidate = {
  id: string;
  label: string;
  provider: string;
  providerAssetId: string;
  contentKey: string;
  localPath: string;
  /** The editor's word, and whether it actually looked. `evaluated:false` = nobody looked. */
  editor: { verdict: EditorWord | null; evaluated: boolean };
};

const CANDIDATES: Candidate[] = [
  {
    id: "A",
    label: "modern generic — Berlin drone 2019",
    provider: "pexels",
    providerAssetId: "pex-88121",
    contentKey: "stock:vid:88121",
    localPath: "/w/scene_1_b5_pexels_0.mp4",
    editor: { verdict: "does_not_fit", evaluated: true },
  },
  {
    id: "B",
    label: "the event — Soviet troops Berlin 1945",
    provider: "internet_archive",
    providerAssetId: "SovietBerlin1945",
    contentKey: "internet_archive:SovietBerlin1945",
    localPath: "/w/scene_1_b5_archive_0.mp4",
    editor: { verdict: "fits", evaluated: true },
  },
  {
    id: "C",
    label: "subject only — Hitler portrait, no event",
    provider: "wikimedia",
    providerAssetId: "Bundesarchiv_portrait",
    contentKey: "wikimedia:Bundesarchiv_portrait",
    localPath: "/w/scene_1_b5_wiki_0.mp4",
    editor: { verdict: "unknown", evaluated: true },
  },
  {
    id: "D",
    label: "plainly wrong — beach holiday",
    provider: "pixabay",
    providerAssetId: "pix-4410",
    contentKey: "stock:vid:4410",
    localPath: "/w/scene_1_b5_pixabay_0.mp4",
    editor: { verdict: "does_not_fit", evaluated: true },
  },
];

/**
 * One beat, walked through the real functions in production order. Returns what each stage did,
 * so the assertions below read the pipeline's own output rather than a re-derivation of it.
 */
function walkOneBeat(
  candidates: Candidate[],
  opts: { route?: string } = {}
) {
  const route = opts.route ?? "internet_archive";
  const ledger = new VisualSourceLedger({ renderId: "r232", videoId: 232 });
  const shortlist = createBeatShortlistState();
  const steps: Array<{
    id: string;
    eligible: boolean;
    admitted: boolean;
    vision: AdoptionVisionVerdict;
    allowed: boolean;
    code?: string;
    reason?: string;
  }> = [];

  for (const c of candidates) {
    /** 1. RETRIEVAL → LINEAGE. A real record, opened the way a provider fetch opens one. */
    const record = ledger.createLineage({
      sceneIndex: SCENE,
      beatIndex: BEAT,
      beatText: BEAT_TEXT,
      candidateId: c.id,
      contentKey: c.contentKey,
      localPath: c.localPath,
      mediaType: "video",
      route: "primary",
      provider: c.provider,
      providerAssetId: c.providerAssetId,
    });
    expect(record, `${c.id} got no lineage record`).toBeTruthy();

    /** 2. ELIGIBILITY — the real ledger write and the real read. */
    ledger.markEligible(c.localPath, c.contentKey, "technical gate passed");
    const eligible = ledger.isEligible(c.localPath, c.contentKey);

    /** 3. SHORTLIST — the real bound, admitted before the editor is asked, as production does. */
    noteEligible(shortlist, SCENE, BEAT);
    const admission = admitToShortlist(shortlist, SCENE, BEAT, c.contentKey, CAP);

    /** 4. VISION — the deterministic input, read through the real verdict vocabulary. */
    const vision = visionVerdictFromGate(c.editor.verdict, c.editor.evaluated);
    if (admission.admitted) {
      if (vision === "NOT_ASKED") {
        releaseShortlistSlot(shortlist, SCENE, BEAT, c.contentKey, CAP);
      } else {
        noteVisionAsked(shortlist, SCENE, BEAT, c.contentKey);
      }
    }

    /** 5. ADOPTION — the real guard, under the real ambient intent. */
    const verdict = withAdoptionIntent(route, () => {
      expect(currentAdoptionIntent()).toBe(route);
      return adoptionGuardVerdict({ source: route, eligible, vision });
    });

    steps.push({
      id: c.id,
      eligible,
      admitted: admission.admitted,
      vision,
      allowed: verdict.allowed,
      ...(verdict.allowed ? {} : { code: verdict.code, reason: verdict.reason }),
    });
  }

  return { steps, ledger, shortlist, funnel: beatFunnel(shortlist, SCENE, BEAT) };
}

/* ═══════════ 1. the search gate, on this beat's own words ═══════════ */

describe("R232 §1 — intent reaches the query, and the gate reads it", () => {
  it("A QUERY MADE OF FILM VOCABULARY IS REFUSED", () => {
    for (const bad of ["documentary", "historical", "establishing", "wide aerial"]) {
      const v = validateSearchQuery(bad);
      expect(v.ok, `"${bad}" was accepted as a search`).toBe(false);
    }
  });

  it("A QUERY MADE OF THE BEAT'S OWN CONTENT IS ALLOWED", () => {
    const v = validateSearchQuery("Soviet Berlin 1945");
    expect(v.ok, `refused with ${v.reason ?? "?"} on "${v.offendingTerm ?? ""}"`).toBe(true);
  });

  it("the refusal names the offending term, so a log can say which word sank it", () => {
    const v = validateSearchQuery("documentary");
    expect(v.ok).toBe(false);
    expect(v.reason).toBeTruthy();
  });

  it("an empty query is refused before anything is spent", () => {
    expect(validateSearchQuery("   ").ok).toBe(false);
    expect(validateSearchQuery("   ").reason).toBe("EMPTY_QUERY");
  });

  it("MEASURED: Führerbunker survives as itself — no mangled stem reaches a provider", () => {
    /**
     * Render 576's log carried `hrerbunker`. Whatever a query is normalised to, the ORIGINAL word
     * must still be recognisable, or a provider is asked for a word no archive holds.
     */
    const v = validateSearchQuery("Führerbunker Berlin 1945");
    expect(v.offendingTerm ?? "").not.toContain("hrerbunker");
    for (const word of ["Göring", "München"]) {
      expect(validateSearchQuery(`${word} 1945`).offendingTerm ?? "").not.toMatch(/^[a-z]{3,}$/);
    }
  });
});

/* ═══════════ 2. the whole chain, one beat ═══════════ */

describe("R232 §2 — four candidates, one beat, the real chain", () => {
  it("THE EVENT FOOTAGE IS ADOPTED", () => {
    const { steps } = walkOneBeat(CANDIDATES);
    const b = steps.find((s) => s.id === "B")!;
    expect(b.eligible).toBe(true);
    expect(b.vision).toBe("APPROVED");
    expect(b.allowed, `B was refused: ${b.reason ?? ""}`).toBe(true);
  });

  it("THE PLAINLY WRONG FOOTAGE IS REFUSED, AND THE REASON NAMES THE VERDICT", () => {
    const { steps } = walkOneBeat(CANDIDATES);
    const d = steps.find((s) => s.id === "D")!;
    expect(d.vision).toBe("REJECTED");
    expect(d.allowed, "a beach holiday reached the montage").toBe(false);
    expect(d.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
    expect(d.reason).toContain("vision (REJECTED)");
  });

  it("THE MODERN MISMATCH IS REFUSED TOO — a refusal is a refusal whatever the provider", () => {
    const { steps } = walkOneBeat(CANDIDATES);
    const a = steps.find((s) => s.id === "A")!;
    expect(a.vision).toBe("REJECTED");
    expect(a.allowed).toBe(false);
  });

  it("THE SUBJECT-ONLY CANDIDATE IS NOT VERIFIED — UNCLEAR is not a yes", () => {
    /**
     * On REAL_FUNNEL, which claims a verified own visual, only APPROVED will do. This is the line
     * RONDE 199 drew and RONDE 97 tuned: UNCLEAR still passes the WEAKER claims, and this test
     * pins the strong one so a future round cannot quietly widen it.
     */
    const { steps } = walkOneBeat(CANDIDATES);
    const c = steps.find((s) => s.id === "C")!;
    expect(c.vision).toBe("UNCLEAR");
    expect(adoptionPolicyFor("internet_archive").category).toBe("REAL_FUNNEL");
    expect(c.allowed, "an unread picture was adopted as a verified own visual").toBe(false);
    expect(c.reason).toContain("vision (UNCLEAR)");
  });

  it("EXACTLY ONE OF FOUR IS ADOPTED — the pipeline chose, it did not take the first arrival", () => {
    const { steps } = walkOneBeat(CANDIDATES);
    expect(steps.filter((s) => s.allowed).map((s) => s.id)).toEqual(["B"]);
  });

  it("and the order of arrival does not change the outcome", () => {
    const reversed = [...CANDIDATES].reverse();
    const { steps } = walkOneBeat(reversed);
    expect(steps.filter((s) => s.allowed).map((s) => s.id)).toEqual(["B"]);
  });
});

/* ═══════════ 3. nobody looked is not a verdict ═══════════ */

describe("R232 §3 — NOT_ASKED travels the whole chain as NOT_ASKED", () => {
  const unseen: Candidate[] = [
    {
      ...CANDIDATES[1]!,
      id: "B-unseen",
      editor: { verdict: null, evaluated: false },
    },
  ];

  it("AN UNJUDGED PICTURE IS NOT ADOPTED, however eligible it is", () => {
    const { steps } = walkOneBeat(unseen);
    const s = steps[0]!;
    expect(s.eligible, "the fixture stopped being eligible").toBe(true);
    expect(s.vision).toBe("NOT_ASKED");
    expect(s.allowed, "render 569's hole reopened").toBe(false);
    expect(s.reason).toContain("vision (NOT_ASKED)");
  });

  it("AND ITS SHORTLIST PLACE COMES BACK — R230-A, exercised through the chain", () => {
    const { funnel } = walkOneBeat(unseen);
    expect(funnel.visionAsked, "an ask was recorded for a look that never happened").toBe(0);
    expect(funnel.slotsReleased, "the place stayed spent on a non-judgement").toBe(1);
    expect(funnel.shortlisted).toBe(0);
  });

  it("a judged picture keeps its place — the bound still binds", () => {
    const { funnel } = walkOneBeat(CANDIDATES);
    expect(funnel.visionAsked).toBe(4);
    expect(funnel.slotsReleased).toBe(0);
    expect(funnel.shortlisted).toBe(4);
  });

  it("MEASURED: eight unjudged arrivals do not close the beat", () => {
    const many: Candidate[] = Array.from({ length: 9 }, (_, i) => ({
      ...CANDIDATES[1]!,
      id: `u${i}`,
      contentKey: `internet_archive:unseen-${i}`,
      localPath: `/w/unseen_${i}.mp4`,
      providerAssetId: `unseen-${i}`,
      editor: { verdict: null, evaluated: false },
    }));
    const { steps, funnel } = walkOneBeat(many);
    expect(steps.every((s) => s.admitted), "render 576's deadlock is back").toBe(true);
    expect(funnel.slotsReleased).toBeGreaterThanOrEqual(CAP);
  });
});

/* ═══════════ 4. what the adopted asset leaves behind ═══════════ */

describe("R232 §4 — the adopted asset has a record, and so do the refused ones", () => {
  it("EVERY CANDIDATE HAS A LINEAGE RECORD — none arrived anonymously", () => {
    const { ledger } = walkOneBeat(CANDIDATES);
    expect(ledger.allRecords().length).toBe(CANDIDATES.length);
  });

  it("THE RECORD CARRIES THE PROVIDER AND THE ASSET, not a filename", () => {
    const { ledger } = walkOneBeat(CANDIDATES);
    const b = CANDIDATES[1]!;
    const rec = ledger.resolve(b.localPath, b.contentKey);
    expect(rec, "the adopted asset cannot be resolved from its own path").toBeTruthy();
    expect(ledger.providerFor(b.localPath, b.contentKey)).toBe("internet_archive");
  });

  it("ELIGIBILITY IS READ BACK FROM THE LEDGER, not from a local variable", () => {
    const { ledger } = walkOneBeat(CANDIDATES);
    for (const c of CANDIDATES) {
      expect(ledger.isEligible(c.localPath, c.contentKey), `${c.id} lost its eligibility`).toBe(true);
    }
  });

  it("A REFUSED CANDIDATE IS STILL ON THE RECORD — a refusal is not a disappearance", () => {
    const { ledger } = walkOneBeat(CANDIDATES);
    const d = CANDIDATES[3]!;
    expect(ledger.resolve(d.localPath, d.contentKey)).toBeTruthy();
  });

  it("the same asset under a second filename resolves to one identity", () => {
    /** The R230-B rule, seen from the lineage side: identity is the asset, not the path. */
    const b = CANDIDATES[1]!;
    expect(
      preparationKey({ assetIdentity: `internet_archive:${b.providerAssetId}`, holdSec: 2.5, variant: "x.mp4" })
    ).toBe(
      preparationKey({ assetIdentity: `internet_archive:${b.providerAssetId}`, holdSec: 2.5, variant: "x.mp4" })
    );
  });
});

/* ═══════════ 5. the guard cannot be walked around ═══════════ */

describe("R232 §5 — no route claims more than it can show", () => {
  it("AN UNDECLARED ROUTE IS REFUSED OUTRIGHT", () => {
    const v = adoptionGuardVerdict({
      source: "some_route_nobody_declared",
      eligible: true,
      vision: "APPROVED",
    });
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error("unreachable");
    expect(v.code).toBe("UNDECLARED_ADOPT_ROUTE");
  });

  it("ELIGIBILITY ALONE IS NOT ENOUGH ON A REAL_FUNNEL ROUTE", () => {
    const v = adoptionGuardVerdict({ source: "internet_archive", eligible: true, vision: "NOT_ASKED" });
    expect(v.allowed).toBe(false);
  });

  it("A VERDICT ALONE IS NOT ENOUGH EITHER — the technical gate still counts", () => {
    const v = adoptionGuardVerdict({ source: "internet_archive", eligible: false, vision: "APPROVED" });
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error("unreachable");
    expect(v.reason).toContain("eligibility");
  });

  it("THIS FILE HAS TEETH — with enforcement off, the same four candidates all pass", () => {
    /**
     * A suite that goes green on its first run is worth doubting, so this proves the assertions
     * above depend on the guard actually enforcing rather than on the fixture being agreeable.
     * `ENFORCE_FUNNEL_ADOPTION=false` is the operator's documented incident switch; flipping it
     * for the length of one assertion changes nothing in production and nothing on disk.
     *
     * With it off, all four — including the beach holiday — are allowed. That is the measurement:
     * every refusal above is the guard's doing, not the scenario's.
     */
    const saved = process.env.ENFORCE_FUNNEL_ADOPTION;
    try {
      process.env.ENFORCE_FUNNEL_ADOPTION = "false";
      const { steps } = walkOneBeat(CANDIDATES);
      expect(
        steps.filter((s) => s.allowed).map((s) => s.id),
        "the guard was not what refused the wrong footage"
      ).toEqual(["A", "B", "C", "D"]);
    } finally {
      if (saved === undefined) delete process.env.ENFORCE_FUNNEL_ADOPTION;
      else process.env.ENFORCE_FUNNEL_ADOPTION = saved;
    }
    /** And the default is restored, so the strict path is what the rest of the suite sees. */
    const { steps } = walkOneBeat(CANDIDATES);
    expect(steps.filter((s) => s.allowed).map((s) => s.id)).toEqual(["B"]);
  });

  it("A FALLBACK IS NOT PRESENTED AS VERIFIED EVENT FOOTAGE", () => {
    /**
     * The categories are the claim. Whatever a fallback route is allowed to do, it must not be
     * filed under the category that means "a verified own visual".
     */
    const fallback = adoptionPolicyFor("fallback");
    expect(fallback.category).not.toBe("REAL_FUNNEL");
    const placeholder = adoptionPolicyFor("rescue_placeholder");
    expect(placeholder.category).not.toBe("REAL_FUNNEL");
  });
});
