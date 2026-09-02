/**
 * THE PICTURE EDITOR WAS ANSWERING ABOUT THE FILM.
 *
 * ── Render 563, in the judge's own words ────────────────────────────────────────────────────
 *
 *     [BeatRelevance] s0b1 gate:archive fits
 *       depicts="Street scene with people in front of a building marked 'Apteka', likely
 *                historical footage."
 *       reason="The footage appears historical, depicting a scene from the World War II era.
 *               It fits the context of the documentary, which is about Hitler and the choices…"
 *
 * The narration for that shot was about Martin Bormann and a note that reached Berlin. The clip is
 * a pharmacy street. The judge approved it, said why, and its reason is the defect: it matched the
 * clip against THE DOCUMENTARY.
 *
 * ── The prompt let it ───────────────────────────────────────────────────────────────────────
 *
 * `Documentary: "<title>"` was presented as ordinary context, and the decision clause read "the
 * subject, the place or the period fits" — without ever saying WHOSE subject, place or period.
 * Read literally, a wartime street fits a wartime film. Almost nothing could fail that question,
 * which is why period-plausible and subject-wrong material kept reaching the montage.
 *
 * ── What these tests hold, and what they refuse to let happen ───────────────────────────────
 *
 * The question's SCOPE narrows to the one line of narration. The BAR does not move: honest
 * atmospheric footage still belongs, uncaptioned archive material still belongs, and the gate
 * still fails open when the model cannot tell. A stricter bar would empty montages — that is a
 * product decision, and it is deliberately not this change. Half these tests exist to catch it
 * being made by accident.
 */
import { describe, expect, it } from "vitest";

import { buildBeatImagePrompt } from "./beatImageRelevanceGate";

const BEAT = "Martin Bormann sent an unexpected note that reached Berlin before the decision.";
const TITLE = "The Unseen Forces That Shaped Hitler's World War II Decisions";
const SCENE = "In the winter of 1941 the men around Hitler were divided.";

const prompt = (frames = 3) => buildBeatImagePrompt(BEAT, frames, TITLE, SCENE);

/* ═══════════════════════ the question is the line ═══════════════════════ */

describe("the judge is asked about one line of narration", () => {
  it("names the narration as the question", () => {
    expect(prompt()).toContain(`THE QUESTION — narration for this shot: "${BEAT}"`);
  });

  /** The two pieces of context the model mistook for the question. */
  it("marks the documentary title as background, not as the thing to match", () => {
    const p = prompt();
    expect(p).toContain(`Documentary, for background only — NOT the question: "${TITLE}"`);
    expect(
      p,
      "the title is still offered as a bare fact the model can match a clip against"
    ).not.toContain(`Documentary: "${TITLE}"`);
  });

  it("marks the scene as background too", () => {
    expect(prompt()).toContain("Scene, for background only — NOT the question:");
  });

  /**
   * The unscoped clause, gone. This exact sentence is what made a wartime street pass under
   * narration about a courier's note: nothing in it says whose subject or whose period.
   */
  it("no longer asks whether 'the subject, the place or the period' fits, unscoped", () => {
    expect(
      prompt(),
      "the decision clause is unscoped again — any clip fits any film of the right era"
    ).not.toContain("the subject, the\nplace or the period fits, or it is honest atmospheric");
  });

  /** And the replacement is pinned to the line. */
  it("pins the decision to that line", () => {
    const p = prompt();
    expect(p).toContain("Then decide, about that ONE line of narration.");
    expect(p).toContain("It BELONGS when a viewer would accept it under THAT LINE");
  });

  /**
   * RENDER 564 narrowed this rule, and the narrowing is the point.
   *
   * The first version said "fitting the documentary's general topic is NOT a reason to say it
   * belongs" — which, together with "the documentary as a whole is not what they are watching",
   * told the model to refuse anything that was not literally the sentence. It refused footage of
   * Adolf Hitler under a documentary about Adolf Hitler; see the block below.
   *
   * What the rule was always FOR is the era-alone leap, and that is what it says now.
   */
  it("refuses the era on its own as a reason", () => {
    const p = prompt();
    expect(p).toContain("The era on its own is never enough.");
    expect(
      p,
      "the prompt does not explain WHY that reason is empty, so it reads as an arbitrary rule"
    ).toContain("equally true of every other shot in the film");
    expect(
      p,
      "and it must say what WOULD be enough, or it is a refusal with no way back"
    ).toContain("something the line itself names or describes has to be there as well");
  });

  /**
   * THE OVERSHOOT, AND WHY IT MUST NOT COME BACK.
   *
   * Render 564 refused, on a film called "Why Did Adolf Hitler Choose Suicide Over Escape?":
   *
   *     "Adolf Hitler giving a speech, likely during World War II era."
   *     "Adolf Hitler standing amidst a crowd of soldiers, likely during WWII, in black and white"
   *     "Adolf Hitler and German officers in military uniforms outdoors."
   *
   * 91% of everything the judge saw, against 47% the render before. Eight of twenty-three beats
   * ended on a placeholder and the quality score was 0.
   *
   * A documentary about a person shows that person. These assertions exist so that permission
   * cannot be edited away again while the tests stay green.
   */
  it("lets the line's own named subject count", () => {
    const p = prompt();
    expect(p, "the named-subject permission is gone — the judge will refuse the film's own subject")
      .toContain("someone or something the line NAMES is on screen");
    expect(
      p,
      "without this, footage of the right person filmed at another moment reads as a mismatch"
    ).toContain("even when it was filmed at");
  });

  /** The three grounds are offered as alternatives, not as a set of requirements. */
  it("states the grounds as alternatives", () => {
    expect(prompt()).toContain("Any one of these is enough:");
  });

  /**
   * The two sentences that caused the overshoot, gone. Either one alone is enough to make the
   * model treat "not literally this sentence" as "does not belong".
   */
  it.each([
    "the documentary as a whole is not what they are watching",
    "Fitting the documentary's general topic is NOT a reason",
    "and nothing else",
  ])("no longer tells the model to disregard the film: %s", (phrase) => {
    expect(prompt(), `"${phrase}" is back; it refuses the documentary's own subject`).not.toContain(
      phrase
    );
  });
});

/* ═══════════════════════ the bar did not move ═══════════════════════ */

describe("nothing was made stricter", () => {
  /**
   * The single most consequential line to keep. Refusing atmospheric footage would empty montages
   * of exactly the material a historical documentary is made of, and that was not the decision.
   */
  it("honest atmospheric footage still belongs", () => {
    expect(
      prompt(),
      "atmospheric footage was quietly disallowed — that empties the montage"
    ).toContain("honest atmospheric");
    expect(prompt(), "it is now scoped to the line, which is the whole change").toContain(
      "footage of the era and setting THAT LINE describes"
    );
  });

  it("uncaptioned archive material still belongs", () => {
    expect(prompt()).toContain("Archive material with no caption still belongs");
  });

  /** The fail-open rule. A judge that guesses "no" when unsure is a judge that empties beats. */
  it("still fails open when the model cannot tell", () => {
    expect(
      prompt(),
      "the gate no longer fails open — an unsure model now refuses pictures"
    ).toContain("When you genuinely cannot tell, say it belongs.");
  });

  /** Every refusal clause, unchanged — this change adds one, it removes none. */
  it.each([
    "a different century",
    "a different country with nothing to do with the story",
    "modern footage",
    "a logo, a title card, a screenshot of a webpage",
    "Judge the picture, not its file name",
  ])("keeps the existing rule: %s", (clause) => {
    expect(prompt()).toContain(clause);
  });

  /** The multi-frame rules are untouched on both branches. */
  it("still judges across all frames of a clip", () => {
    expect(prompt(3)).toContain("The frames are from the SAME clip at different moments");
    expect(prompt(3)).toContain("If most of what is on screen is a title card");
    expect(prompt(1), "the single-frame branch grew a multi-frame sentence").not.toContain(
      "The frames are from the SAME clip"
    );
  });
});

/* ═══════════════════════ the cache key still agrees with the question ═══════════════════════ */

describe("the beat identity and the prompt still describe the same beat", () => {
  /**
   * `beatIdentityKey` hashes the same 300-character slices this prompt uses, so that two clips
   * judged against the same narration are recognised as the same question. Changing a slice here
   * without changing it there would split the cache and silently re-ask paid-for questions.
   */
  it("slices the narration and the scene at 300 characters, as the identity does", () => {
    const long = "x".repeat(400);
    const p = buildBeatImagePrompt(long, 1, TITLE, long);
    expect(p).toContain(`THE QUESTION — narration for this shot: "${"x".repeat(300)}"`);
    expect(p).not.toContain("x".repeat(301));
  });

  /** A scene identical to the beat adds nothing — it would just repeat the question. */
  it("omits the scene when it is the narration itself", () => {
    expect(buildBeatImagePrompt(BEAT, 1, TITLE, BEAT)).not.toContain("Scene, for background only");
  });

  /** And an absent title prints no empty placeholder. */
  it("says nothing about a documentary it was not given", () => {
    expect(buildBeatImagePrompt(BEAT, 1)).not.toContain("Documentary");
  });
});
