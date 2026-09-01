/**
 * GRAPHICS MASTER FIX — the planner asks for the graphic the beat actually needs.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────────────────────
 *
 * `RENDERABLE_GRAPHICS` lists 32 names Remotion has components for. The planner's vocabulary was
 * nine, of which four reached a component (R207). So the single most ordinary documentary graphic
 * — a person's name under their face — was drawable by the renderer and UNREQUESTABLE by the
 * planner. The same for a date card, a place card and a pull quote.
 *
 * That is not a rendering bug and no amount of Remotion work would have found it: the renderer was
 * never asked. It is a vocabulary gap between two halves of one feature.
 *
 * ── What these tests are careful NOT to assert ──────────────────────────────────────────────
 *
 * Not "every beat gets a graphic". The brief is explicit that `graphic = true` for everything is
 * the failure mode, so the ordinary-action case below requires SILENCE, and each trigger is tied
 * to evidence the beat actually carries. A planner that fired on everything would pass a
 * "graphics exist" test and make a worse video.
 */
import { describe, expect, it } from "vitest";

import { planMotionGraphics } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { RENDERABLE_GRAPHICS } from "./graphicsVocabulary";
import { rendererGraphicType } from "./edlToTimeline";
import type { VisualIntent } from "./visualMatchingV2/types";

/** A beat's intent with nothing proven — each test adds only the evidence it is about. */
function intent(over: Partial<VisualIntent> = {}): VisualIntent {
  return {
    beatId: "s0b0",
    spokenText: "",
    visualSubject: "",
    visualAction: "",
    visualLocation: "",
    visualTime: "",
    historicalContext: "",
    emotion: "neutral",
    visualDescription: "",
    primaryKeyword: "",
    secondaryKeyword: "",
    negativeKeywords: [],
    secondaryVisualSubjects: [],
    objects: [],
    brands: [],
    companies: [],
    people: [],
    countries: [],
    events: [],
    intentHash: "h",
    cacheHit: false,
    ...over,
  } as VisualIntent;
}

const plan = (i: VisualIntent) => planMotionGraphics(i, undefined, 10, 6);
const typesOf = (i: VisualIntent) => plan(i).map((g) => g.graphicType);

/* ═══════════════════════ the six scenarios the brief names ═══════════════════════ */

describe("GRAPHICS — a person the beat names gets identified", () => {
  it("plans a lower third for a named person", () => {
    expect(typesOf(intent({ people: ["Elon Musk"], spokenText: "Elon Musk announced the new Tesla vehicle." })))
      .toContain("lower_third");
  });

  /** The name on the card is the beat's own word — never a guess about who is on screen. */
  it("puts the beat's own name on the card, and nothing invented", () => {
    const g = plan(intent({ people: ["Claus von Stauffenberg"] })).find((x) => x.graphicType === "lower_third")!;
    expect(JSON.stringify(g.data)).toContain("Claus von Stauffenberg");
    expect(g.reason).toContain("Claus von Stauffenberg");
  });

  /**
   * The "ELON MUSK / CEO — Tesla" shape, built only when the SAME beat names an organisation.
   * A beat that names a person and no company gets the name alone rather than an invented role.
   */
  it("adds the organisation as a subtitle only when the beat names one", () => {
    const withCompany = plan(intent({ people: ["Elon Musk"], companies: ["Tesla"] }))
      .find((g) => g.graphicType === "lower_third")!;
    expect(JSON.stringify(withCompany.data)).toContain("Tesla");

    const withoutCompany = plan(intent({ people: ["Elon Musk"] }))
      .find((g) => g.graphicType === "lower_third")!;
    expect(JSON.stringify(withoutCompany.data)).not.toMatch(/subtitle/);
  });
});

describe("GRAPHICS — a date the beat states", () => {
  it("plans a date card for a year with no dated event", () => {
    expect(typesOf(intent({ spokenText: "The launch happened in 2019.", visualTime: "2019" })))
      .toContain("date_card");
  });

  /**
   * And does NOT double up: a beat with a dated historical event already gets a timeline, which
   * puts the year on screen. Two cards showing the same number is the kind of clutter the brief
   * calls out.
   */
  it("does not add one when a timeline already carries the year", () => {
    const types = typesOf(intent({
      events: ["assassination attempt"],
      historicalContext: "Second World War",
      visualTime: "1944",
      spokenText: "The attempt took place in 1944.",
    }));
    expect(types).toContain("timeline");
    expect(types).not.toContain("date_card");
  });
});

describe("GRAPHICS — a place the beat names", () => {
  /** The world map only knows a curated coordinate list; every other real place got nothing. */
  it("plans a location card for a place the map does not know", () => {
    expect(typesOf(intent({ visualLocation: "Wolf's Lair" }))).toContain("location_card");
  });

  it("prefers the map when the place IS on the coordinate list", () => {
    const types = typesOf(intent({ visualLocation: "Berlin", spokenText: "in Berlin" }));
    expect(types).toContain("map");
    expect(types, "both a map and a card for one place").not.toContain("location_card");
  });
});

describe("GRAPHICS — a quotation the narration contains", () => {
  it("plans a quote card for a real quoted span", () => {
    expect(typesOf(intent({ spokenText: 'He said "the die is cast, and we must act now".' })))
      .toContain("quote");
  });

  /** Only a real quotation. Nothing is paraphrased into a quote card. */
  it("does not invent a quote from unquoted narration", () => {
    expect(typesOf(intent({ spokenText: "He said the die was cast and they had to act." })))
      .not.toContain("quote");
  });

  it("skips a quoted fragment too short to be worth a card", () => {
    expect(typesOf(intent({ spokenText: 'He said "yes".' }))).not.toContain("quote");
  });
});

describe("GRAPHICS — an ordinary beat gets nothing", () => {
  /**
   * The brief's own example, and the test that keeps this honest: "The crowd applauded" carries no
   * person, no date, no place, no number and no quotation, so it must produce SILENCE. A planner
   * that fires on everything passes a "graphics exist" test and makes a worse video.
   */
  it("plans no graphic for a beat with nothing to visualise", () => {
    expect(plan(intent({ spokenText: "The crowd applauded.", visualAction: "applauding" }))).toEqual([]);
  });

  it("plans nothing for an entirely empty intent", () => {
    expect(plan(intent())).toEqual([]);
  });
});

/* ═══════════════════════ everything planned can actually be drawn ═══════════════════════ */

describe("GRAPHICS — the four new types reach a component and carry their words", () => {
  /**
   * The R178 defect, guarded for the new types on the day they arrive: a planner type that reaches
   * no component is a graphic the render silently loses.
   */
  it("every new type is a name the renderer has a component for", () => {
    for (const t of ["lower_third", "date_card", "location_card", "quote"] as const) {
      expect(RENDERABLE_GRAPHICS.has(rendererGraphicType(t)), `${t} has no component`).toBe(true);
    }
  });

  /**
   * Content-aware, per the brief: never a placeholder. Every graphic this planner emits must carry
   * text the beat actually supplied, and every one must say why it was planned.
   */
  it("no planned graphic is empty or placeholder-filled", () => {
    const rich = intent({
      people: ["Elon Musk"],
      companies: ["Tesla"],
      visualLocation: "Fremont factory",
      visualTime: "2019",
      spokenText: 'In 2019 Elon Musk said "this changes everything" at the Fremont factory.',
    });
    const planned = plan(rich);
    expect(planned.length).toBeGreaterThanOrEqual(3);
    for (const g of planned) {
      const payload = JSON.stringify(g.data);
      expect(payload, `${g.graphicType} is empty`).not.toBe("{}");
      for (const bad of ["Lorem", "ipsum", "Placeholder", "Example", "N/A", "Unknown", "TODO"]) {
        expect(payload, `${g.graphicType} contains "${bad}"`).not.toContain(bad);
      }
      expect(g.reason.length, `${g.graphicType} has no reason`).toBeGreaterThan(20);
    }
  });

  /**
   * Duration has to suit what is being read. A name is glanced at; a quote is read. The brief
   * forbids both a flash too short to read and a card that outstays its beat.
   */
  it("gives a quote longer on screen than a date, and never outstays the beat", () => {
    const beatSec = 6;
    const planned = planMotionGraphics(
      intent({ visualTime: "2019", spokenText: 'In 2019 he said "the die is cast, we must act".' }),
      undefined, 10, beatSec
    );
    const quote = planned.find((g) => g.graphicType === "quote")!;
    const date = planned.find((g) => g.graphicType === "date_card")!;
    expect(quote.durationSec).toBeGreaterThan(date.durationSec);
    for (const g of planned) {
      expect(g.durationSec, `${g.graphicType} is too short to read`).toBeGreaterThanOrEqual(2);
      expect(g.durationSec, `${g.graphicType} outstays its beat`).toBeLessThanOrEqual(beatSec);
    }
  });
});
