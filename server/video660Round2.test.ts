/**
 * VIDEO 660 — the second fix round, from the first look at the delivered frames of render 69.
 *
 *   A  footage whose signs, captions or title tie it to another story is refused (Rafah protest)
 *   B  burned-in subtitles, captions and news tickers are refused; a small corner logo may stay;
 *      a refused picture sends the sentence to its other candidates
 *   C  no AI picture of a person the sentence OR the director's plan names (Lagarde look-alike)
 *   D  a map only for a place the sentence itself says (London under "European households")
 */
import { describe, expect, it } from "vitest";

import { acceptableRule, buildBeatImagePrompt } from "./beatImageRelevanceGate";
import { overlayVerdictOf, parseOverlayDetectorReply } from "./archiveClipFilter";
import { pictureCheckMissing } from "./deliveryGate";
import { generatedImageDecision, namesAnOfficeHolder } from "./generatedImageFallback";
import { runMandatoryChecks, textCheckFromVerdict, textPasses } from "./mandatoryPictureChecks";
import { onScreenTextRefusesBeforeVision } from "./visualJudge";
import { classifyMismatch, mismatchSeverity } from "./visualMismatchFeedback";
import { sheetPrompt } from "./youtubePreviewSheet";

/* ═══════════ A ═══════════ */

describe("A — footage whose signs or captions belong to another story is refused", () => {
  const LINE = "Families strained under these costs, venting frustrations in public demonstrations.";

  it("the picture editor is told to read the signs and refuse a protest about another cause, even when the kind of scene fits", () => {
    const prompt = buildBeatImagePrompt(LINE, 3, "How Inflation Shook Europe in 2026");
    expect(prompt).toMatch(/signs, banners, placards, captions or on-screen titles/);
    expect(prompt).toMatch(/even when the kind of scene \(a protest,\s+a crowd, a meeting\) fits the line/);
    expect(prompt).toMatch(/Begin your reason with\s+"unrelated story:"/);
    /** the film's subject is in front of it */
    expect(prompt).toMatch(/How Inflation Shook Europe in 2026/);
  });

  it("such a refusal is TOTALLY_UNRELATED — never a softer 'different rally' or 'text on screen'", () => {
    const kind = classifyMismatch({
      depicts: "a rally with placards reading 'Hands off Rafah' and a caption 'Moncton: Gaza solidarity'",
      reason: "unrelated story: the placards are about Gaza, a different rally than inflation protests",
    });
    expect(kind).toBe("UNRELATED");
    expect(mismatchSeverity(kind)).toBe("TOTALLY_UNRELATED");
  });

  it("it is never promoted to 'acceptable' because the kind of scene (a protest) matched", () => {
    const refused = {
      verdict: "does_not_fit" as const,
      depicts: "protesters holding 'Hands off Rafah' placards",
      reason: "unrelated story: the placards are about Gaza",
    };
    expect(acceptableRule(refused, { subject_matches: true, situation_matches: false })).toBe(refused);
  });

  it("the YouTube contact sheet carries the same rule, and the sharp look also refuses a news ticker", () => {
    const frames = [{ n: 1, sec: 1 }];
    for (const kind of ["storyboard", "sharp"] as const) {
      expect(sheetPrompt("Europe inflation", [LINE], frames, kind)).toMatch(/signs, banners, placards or\s+captions are about a different story/);
    }
    expect(sheetPrompt("Europe inflation", [LINE], frames, "sharp")).toMatch(/news ticker/);
  });
});

/* ═══════════ B ═══════════ */

describe("B — subtitles, captions and tickers are refused; a small corner logo may stay", () => {
  it("the text check now says which: captions vs a corner logo", () => {
    expect(parseOverlayDetectorReply('{"hasBakedEditText":true,"textFillsPicture":false,"textIsCaptions":true}')).toEqual({
      hasText: true,
      fillsPicture: false,
      captions: true,
    });
    expect(overlayVerdictOf({ hasText: true, fillsPicture: false, captions: true }, "")).toEqual({ verdict: "has_text", textKind: "captions" });
    expect(overlayVerdictOf({ hasText: true, fillsPicture: false, captions: false }, "")).toEqual({ verdict: "has_text", textKind: "overlay" });
    expect(overlayVerdictOf({ hasText: true, fillsPicture: true, captions: true }, "")).toEqual({ verdict: "has_text", textKind: "fills_picture" });
    expect(overlayVerdictOf({ hasText: false, fillsPicture: false, captions: false }, "")).toEqual({ verdict: "clean" });
  });

  it("captions are refused BEFORE the picture editor (the sentence moves on to its next candidate); a corner logo goes on to the editor", () => {
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "captions" })).toBe(true);
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "fills_picture" })).toBe(true);
    expect(onScreenTextRefusesBeforeVision({ decision: "REJECT", textKind: "overlay" })).toBe(false);
    expect(onScreenTextRefusesBeforeVision({ decision: "ACCEPT" })).toBe(false);
  });

  it("a placed picture with captions fails the mandatory check without a second look, and never passes the delivery gate", async () => {
    expect(textCheckFromVerdict({ decision: "REJECT", textKind: "captions" })).toBe("captions");
    expect(textPasses("captions")).toBe(false);
    let looked = 0;
    const outcome = await runMandatoryChecks({
      recordedContent: () => "fit",
      judgeContent: async () => "fit",
      recordedText: () => "captions",
      checkText: async () => {
        looked++;
        return "clean";
      },
    });
    expect(outcome).toMatchObject({ pass: false, text: "captions", reason: "subtitles, captions or a ticker over the picture" });
    expect(looked).toBe(0);
    expect(pictureCheckMissing({ isPlaceholder: false, hidden: false, contentApproval: "judge_fit", textCheck: "captions" })).toMatch(/textCheck=captions/);
  });

  it("a corner logo, and a verdict from before the question existed, still pass as before", () => {
    expect(textPasses("overlay")).toBe(true);
    expect(pictureCheckMissing({ isPlaceholder: false, hidden: false, contentApproval: "judge_fit", textCheck: "overlay" })).toBeNull();
    /** an old reply without the new field reads as a corner logo, never as clean */
    expect(overlayVerdictOf(parseOverlayDetectorReply('{"hasBakedEditText":true,"textFillsPicture":false}'), "")).toEqual({
      verdict: "has_text",
      textKind: "overlay",
    });
  });
});

/* ═══════════ C ═══════════ */

describe("C — no AI picture of a real person, named in the sentence or in the plan", () => {
  const base = { hasPicture: false, graphicCanStandIn: false, people: [] as string[], budgetLeft: 3 };

  it("660 s0b1: the sentence names nobody, the plan names Christine Lagarde — not generated", () => {
    expect(generatedImageDecision({ ...base, planPeople: ["Christine Lagarde"] })).toEqual({
      generate: false,
      reason: "plan_names_a_person",
    });
  });

  it("an office one person holds is that person: 'the ECB president' — not generated", () => {
    expect(
      generatedImageDecision({ ...base, planText: "This crisis wasn't just numbers. ECB president at a press conference" })
    ).toEqual({ generate: false, reason: "names_an_office_holder" });
    expect(namesAnOfficeHolder("the Chancellor addressed parliament")).toBe(true);
    expect(namesAnOfficeHolder("the bank's CEO resigned")).toBe(true);
  });

  it("a plan without people still gets its picture; plural offices and institutions are not a person", () => {
    expect(
      generatedImageDecision({ ...base, planPeople: [], planText: "Empty supermarket shelves across Europe. Finance ministers met in Brussels" })
    ).toEqual({ generate: true });
    expect(namesAnOfficeHolder("the presidential palace")).toBe(false);
    expect(generatedImageDecision({ ...base, planPeople: ["European Central Bank"] })).toEqual({ generate: true });
  });
});
