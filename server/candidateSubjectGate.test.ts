/**
 * REFUSING A CANDIDATE BEFORE PAYING TO FETCH IT.
 *
 * ── The clip this exists for ────────────────────────────────────────────────────────────────
 *
 *     providerAssetId = white-lives-matter-montana-activism-in-butte-2
 *     beat            = "Imagine a world where Adolf Hitler's 1944 ceasefire proposal…"
 *
 * Render 562 downloaded that, trimmed it, extracted frames, and then asked whether it belonged —
 * at 09:37, by which time every vision provider was gone. Nobody answered, the gate fails open,
 * and a present-day protest went into a documentary about the Second World War.
 *
 * The name of the asset says what it is. No frame was ever needed.
 *
 * ── The three properties that make this safe ────────────────────────────────────────────────
 *
 *   1. IT DOWNLOADS NOTHING. Not the video, not a thumbnail. It reads what the search already
 *      returned. (The pipeline has a dormant thumbnail-fetching ranker; this is not it.)
 *   2. IT ONLY REFUSES. A `plausible` verdict proves nothing and skips no later check — the beat
 *      image gate still decides adoption on the real frames. Metadata is evidence about a
 *      subject, never about a file.
 *   3. IT SENDS NO IMAGES, so Groq stays in the provider chain. `invokeLLM` drops Groq from any
 *      chain carrying an image because its vision models 404 — which is why 562's picture editor
 *      had only a spent OpenAI and a project-denied Gemini. Groq answered text all through that
 *      render, so this check still works in exactly the outage that caused the problem.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  buildCandidateSubjectPrompt,
  candidateSubjectGateEnabled,
  candidateSubjectDecision,
  candidateSubjectKey,
  createCandidateSubjectGateState,
  formatCandidateSubjectSummary,
  judgeCandidateSubject,
  maxCandidateSubjectJudgements,
  type CandidateSubjectFacts,
} from "./candidateSubjectGate";

/** The real candidate, with the identifier the production log recorded. */
const OFFENDER: CandidateSubjectFacts = {
  id: "internet_archive:7e1e44119a0a5ca2",
  assetId: "white-lives-matter-montana-activism-in-butte-2",
  source: "internet_archive",
  title: "White Lives Matter Montana activism in Butte",
  description: null,
  tags: [],
};

const BEAT = {
  beatText: "Imagine a world where Adolf Hitler's 1944 ceasefire proposal reshaped Europe.",
  sceneText: "Berlin, Moscow and London redefined.",
  videoTitle: "Hitler's Secret WWII Strategy You Never Knew About",
  anchors: ["Adolf Hitler", "Berlin"],
};

/* ═══════════════════════ the question it asks ═══════════════════════ */

describe("the prompt carries what a screener needs", () => {
  const prompt = buildCandidateSubjectPrompt(OFFENDER, BEAT);

  it("shows the identifier, which is the telling field here", () => {
    expect(prompt).toContain("white-lives-matter-montana-activism-in-butte-2");
  });

  it("shows the narration the item has to sit under", () => {
    expect(prompt).toContain("Adolf Hitler's 1944 ceasefire");
    expect(prompt).toContain("Hitler's Secret WWII Strategy");
  });

  /**
   * The question is deliberately weak. Metadata cannot establish that footage is RIGHT, only that
   * it is obviously about something else — so a vague title must not be grounds for refusal, or
   * this becomes an approval gate on the strength of good copywriting.
   */
  it("asks whether it COULD belong, and says a vague description is not a refusal", () => {
    expect(prompt).toMatch(/plausibly appear/i);
    expect(prompt).toMatch(/vague, generic or empty description is NOT grounds for false/i);
    expect(prompt).toMatch(/answer true when you cannot tell/i);
  });

  it("never asks it to judge quality or composition — that is the image gate's job", () => {
    expect(prompt).not.toMatch(/resolution|sharp|quality|well.?shot|composition/i);
  });

  /** An item with no description at all still gets asked about, on its identifier alone. */
  it("works with nothing but an identifier", () => {
    const bare = buildCandidateSubjectPrompt(
      { ...OFFENDER, title: "", description: null, tags: [] },
      BEAT
    );
    expect(bare).toContain("white-lives-matter-montana-activism-in-butte-2");
  });
});

/* ═══════════════════════ it fetches nothing ═══════════════════════ */

describe("nothing is downloaded to make this decision", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "candidateSubjectGate.ts"), "utf8");

  /**
   * The explicit instruction: no thumbnails. Only real footage may be fetched, and only when a
   * candidate has survived this screen.
   */
  it("the gate has no fetch, no thumbnail, no file read", () => {
    for (const forbidden of ["fetch(", "thumbnailUrl", "axios", "https.get", "readFileSync", "createWriteStream"]) {
      expect(SRC, `the subject gate reaches for ${forbidden} — it must read metadata only`)
        .not.toContain(forbidden);
    }
  });

  /** Its input type carries no URL at all, so a download is not expressible. */
  it("its facts type has no URL to fetch", () => {
    const type = SRC.slice(SRC.indexOf("export type CandidateSubjectFacts"), SRC.indexOf("export type CandidateSubjectContext"));
    expect(type).not.toMatch(/url|Url|URL/);
  });
});

/* ═══════════════════════ it sends no images ═══════════════════════ */

describe("text only, so it survives a vision outage", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "candidateSubjectGate.ts"), "utf8");

  /**
   * This is the property that makes the gate useful. `invokeLLM` filters Groq out of any chain
   * whose messages include an image; a text-only call keeps it. Render 562's vision chain was
   * empty while Groq was answering text throughout.
   */
  it("the call carries no image content", () => {
    const call = SRC.slice(SRC.indexOf("invokeLLM({"), SRC.indexOf("response_format: RESPONSE_SCHEMA"));
    expect(call, "an image would remove Groq from the chain and defeat the whole point")
      .not.toContain("image_url");
    expect(call).not.toContain("data:image");
  });

  it("the LLM module really does drop Groq for images", () => {
    const llm = fs.readFileSync(path.join(__dirname, "_core", "llm.ts"), "utf8");
    expect(
      llm,
      "the premise of this gate is gone — Groq is no longer excluded from vision, so a text-only " +
        "call buys nothing"
    ).toContain('if (hasVision) chain = chain.filter((p) => p !== "groq");');
  });
});

/* ═══════════════════════ it only refuses ═══════════════════════ */

describe("a decline never blocks a candidate", () => {
  it("is inert when switched off", async () => {
    const prev = process.env.ENABLE_CANDIDATE_SUBJECT_GATE;
    process.env.ENABLE_CANDIDATE_SUBJECT_GATE = "false";
    try {
      expect(candidateSubjectGateEnabled()).toBe(false);
      const state = createCandidateSubjectGateState();
      const d = await judgeCandidateSubject({ facts: OFFENDER, ctx: BEAT, state });
      expect(d.allowed, "a switched-off gate refused a candidate").toBe(true);
      expect(d.evaluated).toBe(false);
      expect(state.attempts, "a switched-off gate spent budget").toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_CANDIDATE_SUBJECT_GATE;
      else process.env.ENABLE_CANDIDATE_SUBJECT_GATE = prev;
    }
  });

  it("lets a candidate through when there is no narration to judge against", async () => {
    const state = createCandidateSubjectGateState();
    const d = await judgeCandidateSubject({ facts: OFFENDER, ctx: { ...BEAT, beatText: "  " }, state });
    expect(d.allowed).toBe(true);
    expect(d.evaluated).toBe(false);
  });

  it("lets a candidate through when the provider said nothing about it", async () => {
    const state = createCandidateSubjectGateState();
    const d = await judgeCandidateSubject({
      facts: { id: "x:1", assetId: "", source: "pexels", title: "", description: null, tags: [] },
      ctx: BEAT,
      state,
    });
    expect(d.allowed, "a candidate with no metadata was refused on no evidence").toBe(true);
    expect(d.reason).toContain("no metadata");
  });

  it("lets a candidate through once the budget is spent", async () => {
    const state = createCandidateSubjectGateState();
    state.attempts = maxCandidateSubjectJudgements();
    const d = await judgeCandidateSubject({ facts: OFFENDER, ctx: BEAT, state });
    expect(d.allowed).toBe(true);
    expect(d.reason).toContain("budget spent");
  });

  /** The gate is on unless someone turns it off — a check that stops silently is the recurring bug. */
  it("is on by default", () => {
    const prev = process.env.ENABLE_CANDIDATE_SUBJECT_GATE;
    delete process.env.ENABLE_CANDIDATE_SUBJECT_GATE;
    try {
      expect(candidateSubjectGateEnabled()).toBe(true);
    } finally {
      if (prev !== undefined) process.env.ENABLE_CANDIDATE_SUBJECT_GATE = prev;
    }
  });
});

/* ═══════════════════════ the decision itself ═══════════════════════ */

/**
 * The one place the gate can block anything. It lived inline in the network call, where no test
 * could reach it without simulating a provider — and a mutation setting `allowed: true` on a
 * refusal passed this whole file. Now it is a function, and the refusal is a fact a test holds.
 */
describe("a refusal actually refuses", () => {
  it("couldBelong=false blocks the download", () => {
    const d = candidateSubjectDecision({
      subject: "modern political demonstration",
      couldBelong: false,
      reason: "shows a present-day protest, not wartime footage",
    });
    expect(d?.verdict).toBe("does_not_belong");
    expect(d?.allowed, "a refusal that still allows the download is not a gate").toBe(false);
    expect(d?.evaluated).toBe(true);
    expect(d?.reason, "the refusal does not say what it saw").toContain("modern political demonstration");
  });

  it("couldBelong=true lets it through and claims nothing more", () => {
    const d = candidateSubjectDecision({ subject: "wartime newsreel", couldBelong: true, reason: "period footage" });
    expect(d?.verdict).toBe("plausible");
    expect(d?.allowed).toBe(true);
    /** `plausible` is not `approved`: the image gate still decides adoption on real frames. */
    expect(d?.verdict, "a metadata check must never report an approval").not.toBe("fits");
  });

  /** A malformed answer is not a refusal — the candidate goes on to the real check. */
  it("an answer with no verdict decides nothing", () => {
    expect(candidateSubjectDecision({ subject: "x", reason: "y" })).toBeNull();
    expect(candidateSubjectDecision({ couldBelong: "no" as unknown as boolean })).toBeNull();
  });

  it("a refusal with no explanation still says something usable", () => {
    const d = candidateSubjectDecision({ couldBelong: false });
    expect(d?.allowed).toBe(false);
    expect(d?.reason.length).toBeGreaterThan(10);
  });

  /** `allowed: false` must exist exactly once in the module — the refusal, and nothing else. */
  it("nothing else in the gate can block a candidate", () => {
    const src = fs.readFileSync(path.join(__dirname, "candidateSubjectGate.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      [...src.matchAll(/allowed:\s*false/g)],
      "a second path can block a candidate — every decline must fail open"
    ).toHaveLength(1);
  });
});

/* ═══════════════════════ the cache key ═══════════════════════ */

describe("one asset is judged once per beat, not once per render", () => {
  /**
   * Keyed by asset AND beat. Keying on the asset alone would carry a refusal from one sentence to
   * every other one — the exact defect RONDE 103 fixed in the image gate's cache, where a clip
   * approved on beat 1 was never re-examined on beat 7.
   */
  it("the same asset under a different sentence is a different question", () => {
    expect(candidateSubjectKey("ia:1", "Hitler in 1944")).not.toBe(
      candidateSubjectKey("ia:1", "Churchill in 1940")
    );
  });

  it("the same asset under the same sentence is the same question", () => {
    expect(candidateSubjectKey("ia:1", "Hitler in 1944")).toBe(
      candidateSubjectKey("ia:1", "Hitler in 1944")
    );
  });
});

/* ═══════════════════════ the render can count what it saved ═══════════════════════ */

describe("the summary line", () => {
  it("reports refusals, declines and whether the screen itself was blind", () => {
    const state = createCandidateSubjectGateState();
    state.attempts = 40;
    state.refused = 12;
    state.plausible = 28;
    state.skipped = 3;
    state.providerUnavailable = 2;
    const line = formatCandidateSubjectSummary(state);
    expect(line).toContain("asked=40");
    expect(line, "downloads that did not happen are the point of this line").toContain("refused=12");
    expect(line, "a blind screen must be visible, not silent").toContain("noProvider=2");
  });

  it("says something sane on a render that asked nothing", () => {
    expect(formatCandidateSubjectSummary(createCandidateSubjectGateState())).toContain("asked=0");
  });
});

/* ═══════════════════════ the pipeline uses it before downloading ═══════════════════════ */

describe("it sits in front of the download, not after it", () => {
  const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  /**
   * RENDER 563 moved this rule rather than changing it.
   *
   * This test used to look for a direct `judgeCandidateSubject({` call in the funnel loop, which
   * is exactly what left the scene-pool route unscreened — `[SubjectGate] asked=0`. The gate now
   * has ONE entry point, at the download itself, and the funnel reaches it through that. So the
   * property is unchanged — the shortlist is screened — and the assertion follows it to where the
   * screen actually lives. `subjectGateAtTheDownload.test.ts` pins the chokepoint.
   */
  it("the funnel screens its shortlist", () => {
    expect(PIPE, "nothing screens the funnel's shortlist").toContain(
      "screenCandidateBeforeDownload({"
    );
    expect(
      PIPE,
      "a route judges a candidate directly again, which is how the pool path went unscreened"
    ).not.toContain("judgeCandidateSubject(");
  });

  /** The order is the whole point: screen, then download what survived. */
  it("the download loop runs over the screened list", () => {
    const screenAt = PIPE.indexOf("const subjectScreened");
    const loopAt = PIPE.indexOf("for (let dlIdx = 0; dlIdx < subjectScreened.length");
    expect(screenAt, "the screening step is gone").toBeGreaterThan(-1);
    expect(loopAt, "the download loop no longer reads the screened list").toBeGreaterThan(-1);
    expect(loopAt, "the download happens before the screen").toBeGreaterThan(screenAt);
  });

  /** A curated archive pick is the operator's own library and is deliberately not screened. */
  it("leaves the operator's own archive alone", () => {
    const at = PIPE.indexOf("const subjectVerdicts");
    expect(at, "the screening step has moved").toBeGreaterThan(-1);
    const block = PIPE.slice(at, PIPE.indexOf("const FUNNEL_DOWNLOAD_CONCURRENCY", at));
    expect(block, "a candidate with no pool entry is screened as if it were external")
      .toContain("if (!pool) return { candidate, pool: null, decision: null };");
  });

  /**
   * The screens run at once, not one after another.
   *
   * Six sequential text calls would spend a third of a 12-20s beat budget before any download —
   * the exact defect RONDE 5's FIX 6 fixed for the downloads themselves. Its test caught this
   * when the screening loop was first written sequentially.
   */
  it("screens the shortlist in parallel", () => {
    const at = PIPE.indexOf("const subjectVerdicts");
    const block = PIPE.slice(at, PIPE.indexOf("const subjectScreened", at));
    expect(block, "the screens run one at a time and eat the beat budget").toContain(
      "await Promise.all("
    );
    expect(block).not.toMatch(/for \(const candidate of toScore\)/);
  });

  /**
   * Also relocated, not relaxed. The funnel loop used to record its own refusals, which meant the
   * pool route's refusals — once it had any — would have gone unrecorded. The render now registers
   * one recorder with the gate's scope and every route's refusal reaches it.
   */
  it("records a refusal in the reject audit so the beat can explain itself", () => {
    const at = PIPE.indexOf("subjectGateScope.onRefusal =");
    expect(at, "no route records a subject-gate refusal any more").toBeGreaterThan(-1);
    const block = PIPE.slice(at, at + 500);
    expect(block).toContain("recordClipReject(");
    expect(block).toContain('"subject_gate"');
  });

  it("the render reports what the screen did", () => {
    expect(PIPE).toContain("formatCandidateSubjectSummary(visualDedup.candidateSubjectGate)");
  });
});
