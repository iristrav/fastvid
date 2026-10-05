/**
 * P0 (VIDEO 630) — TEXT ON SCREEN IS NOT THE SAME AS AN UNUSABLE PICTURE.
 *
 * Render 630 had twelve YouTube shots in stock. The on-screen-text check answered `has_text` for
 * all twelve, the beat loop refused every one of them before the picture editor looked
 * (`baked_edit_text_before_vision`), and the film held 0 seconds of YouTube.
 *
 * The same check (same call, no new model) now also says whether the text FILLS the picture. Only
 * that — a title card, a leader, a screenshot of a page — is refused before the picture editor. A
 * logo, a watermark, a subtitle, or a kind the detector did not say, go on to the same editor and
 * the same push checks as any clip. Nothing here approves anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const llm = vi.hoisted(() => ({ reply: "" as string, calls: [] as unknown[] }));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn(async (req: unknown) => {
    llm.calls.push(req);
    return { choices: [{ message: { content: llm.reply } }] };
  }),
}));
vi.mock("./_core/env", async (orig) => {
  const real = (await orig()) as { ENV: Record<string, unknown> };
  return { ...real, ENV: { ...real.ENV, forgeApiKey: "test-key" } };
});

import {
  __resetOverlayVerdictCacheForTest,
  cachedClipBakedEditTextVerdict,
  overlayVerdictOf,
  parseOverlayDetectorReply,
} from "./archiveClipFilter";
import { judgeOnScreenText, onScreenTextRefusesBeforeVision } from "./visualJudge";
import { filmRecordMayCarryOverlayText } from "./archiveIngestion";
import { adoptionGuardVerdict, visionVerdictFromGate } from "./adoptionPolicy";
import { rejectionStageForReason } from "./rejectionRegistry";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const INGEST = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

/** A PNG signature and padding: enough for the format sniff, which is all the detector reads here. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** What the beat loop does with one candidate's text answer: refused before the editor, or asked. */
async function textCheckFor(reply: object, key: string) {
  llm.reply = JSON.stringify(reply);
  const tmp = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "p0-")), "still.png");
  fs.writeFileSync(tmp, PNG);
  const text = await judgeOnScreenText({ path: tmp, mimeType: "image/png", memoKey: key, budget: 40 });
  return { text, refusedBeforeVision: onScreenTextRefusesBeforeVision(text) };
}

beforeEach(() => {
  __resetOverlayVerdictCacheForTest();
  llm.calls.length = 0;
});

describe("P0 — the one text check says whether the text IS the picture", () => {
  it("the same single call is made, its schema now asks both questions", async () => {
    await textCheckFor({ hasBakedEditText: true, textFillsPicture: false }, "k-schema");
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0] as { response_format: { json_schema: { schema: { required: string[] } } } };
    expect(req.response_format.json_schema.schema.required).toEqual(["hasBakedEditText", "textFillsPicture"]);
  });

  it("a reply without the new field is read as an unknown kind, never as a title card", () => {
    expect(parseOverlayDetectorReply('{"hasBakedEditText":true}')).toEqual({ hasText: true });
    expect(overlayVerdictOf({ hasText: true }, "x")).toEqual({ verdict: "has_text" });
    expect(parseOverlayDetectorReply('{"textFillsPicture":true}'), "no answer to the main question").toBeNull();
  });
});

describe("P0 — what reaches the picture editor", () => {
  it("A. a small logo / watermark over footage → reaches the Judge", async () => {
    const { text, refusedBeforeVision } = await textCheckFor({ hasBakedEditText: true, textFillsPicture: false }, "k-logo");
    expect(text.decision).toBe("REJECT");
    expect(text.textKind).toBe("overlay");
    expect(refusedBeforeVision).toBe(false);
  });

  it("B. a burnt-in subtitle over footage → reaches the Judge", async () => {
    const { refusedBeforeVision } = await textCheckFor({ hasBakedEditText: true, textFillsPicture: false }, "k-sub");
    expect(refusedBeforeVision).toBe(false);
  });

  it("C. a large title card (text fills the picture) → still refused before the Judge", async () => {
    const { text, refusedBeforeVision } = await textCheckFor({ hasBakedEditText: true, textFillsPicture: true }, "k-card");
    expect(text.textKind).toBe("fills_picture");
    expect(refusedBeforeVision).toBe(true);
  });

  it("unknown kind → reaches the Judge; clean → reaches the Judge; no answer → reaches the Judge", async () => {
    expect((await textCheckFor({ hasBakedEditText: true }, "k-unknown")).refusedBeforeVision).toBe(false);
    expect((await textCheckFor({ hasBakedEditText: false, textFillsPicture: false }, "k-clean")).refusedBeforeVision).toBe(false);
    expect(onScreenTextRefusesBeforeVision(null)).toBe(false);
  });

  it("the memo keeps the kind: a second ask of the same key costs no call and answers the same", async () => {
    await textCheckFor({ hasBakedEditText: true, textFillsPicture: true }, "k-memo");
    const again = await cachedClipBakedEditTextVerdict("/nonexistent.png", "image/png", "k-memo", 40);
    expect(again).toEqual({ verdict: "has_text", textKind: "fills_picture" });
    expect(llm.calls).toHaveLength(1);
  });
});

describe("P0 — after the text check, the picture editor alone decides placement", () => {
  /** The push's own rule, unchanged: a REAL_FUNNEL route needs eligibility AND an approval. */
  const place = (verdict: string | undefined, evaluated = true) =>
    adoptionGuardVerdict({ source: "beat_fetch", eligible: true, vision: visionVerdictFromGate(verdict, evaluated) }).allowed;

  it("D. relevant shot with limited text + Judge APPROVED → placed normally, its film record stored", async () => {
    const { text, refusedBeforeVision } = await textCheckFor({ hasBakedEditText: true, textFillsPicture: false }, "k-d");
    expect(refusedBeforeVision).toBe(false);
    expect(place("fits")).toBe(true);
    /** The production store keeps it as this film's record, switched off and marked as text. */
    expect(filmRecordMayCarryOverlayText(text, true)).toBe(true);
  });

  it("E. irrelevant shot with limited text + Judge REJECTED → not placed", async () => {
    const { refusedBeforeVision } = await textCheckFor({ hasBakedEditText: true, textFillsPicture: false }, "k-e");
    expect(refusedBeforeVision).toBe(false);
    expect(place("does_not_fit")).toBe(false);
  });

  it("no verdict → not placed (NOT_ASKED and UNCLEAR still refuse): text never stands in for a look", () => {
    expect(place(undefined, false)).toBe(false);
    expect(place("unknown")).toBe(false);
  });

  it("the archive keeps refusing text for everything else: title cards, and anything not a film record", () => {
    expect(filmRecordMayCarryOverlayText({ decision: "REJECT", textKind: "fills_picture" }, true)).toBe(false);
    expect(filmRecordMayCarryOverlayText({ decision: "REJECT", textKind: "overlay" }, false)).toBe(false);
    expect(filmRecordMayCarryOverlayText({ decision: "REJECT", textKind: "overlay" }, undefined)).toBe(false);
    expect(filmRecordMayCarryOverlayText({ decision: "ACCEPT" }, true)).toBe(false);
    /** Exactly one refusal remains, and the exception row is stored switched off. */
    expect([...INGEST.matchAll(/return refuse\("BAKED_EDIT_TEXT"/g)]).toHaveLength(1);
    const exception = INGEST.slice(INGEST.indexOf("filmRecordMayCarryOverlayText(overlay, metadata.usedInFilm)"));
    expect(exception.slice(0, 600)).toContain("metadata.storeSwitchedOff = true;");
    expect(INGEST).toContain("...(metadata.storeSwitchedOff ? { isActive: 0 } : {}),");
    expect(INGEST).toContain("hasBakedEditText: hasText ? 1 : overlay?.evaluated ? 0 : null,");
  });
});

describe("P0 — wiring, and the technical refusal rules it must not move", () => {
  it("the beat loop refuses before the editor only on onScreenTextRefusesBeforeVision", () => {
    expect(PIPE).toContain('if (onScreenTextRefusesBeforeVision(text) && refuse("baked_edit_text_before_vision")) continue;');
    expect(PIPE, "the old unconditional refusal is back").not.toContain(
      'if (text?.decision === "REJECT" && refuse("baked_edit_text_before_vision")) continue;'
    );
  });

  it("a refused title card is still a technical refusal for every sentence, filed as on-screen text", async () => {
    const { refusalHoldsForEverySentence } = await import("./videoPipeline");
    expect(refusalHoldsForEverySentence("baked_edit_text_before_vision")).toBe(true);
    expect(refusalHoldsForEverySentence("mostly_black")).toBe(true);
    expect(refusalHoldsForEverySentence("below_size_floor_100_bytes")).toBe(true);
    expect(rejectionStageForReason("baked_edit_text_before_vision")).toBe("on_screen_text");
    /** A content refusal is still per sentence. */
    expect(refusalHoldsForEverySentence("refused on s0b1: does not fit")).toBe(false);
  }, 120_000);
});
