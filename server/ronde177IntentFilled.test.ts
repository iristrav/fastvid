/**
 * RONDE 177 — the intent fields the planners read are actually fed.
 *
 * ── The failure this closes ──────────────────────────────────────────────────────────────────
 *
 * `intentFrom` hard-coded `visualTime`, `historicalContext`, `objects`, `events`, `brands`,
 * `companies` and `secondaryVisualSubjects` to empty, because visualMatchingV2 fills them from an
 * LLM pass this pipeline does not run. Everything downstream handled the empty case, so nothing
 * ever failed — and a set of real planner rules was simply unreachable on every render:
 *
 *   · captionPlanner's date card         needs visualTime
 *   · captionPlanner's timeline label    needs visualTime + historicalContext + events
 *   · captionPlanner's event label       needs events with no year
 *   · shotPlanner's archive_footage      needs historicalContext
 *   · shotPlanner's extreme_close_up     needs objects
 *   · motionGraphicsPlanner's timeline   needs events + historicalContext
 *   · motionGraphicsPlanner's highlight  needs objects
 *   · motionGraphicsPlanner's brand icon needs brands or companies
 *
 * So these tests do not stop at "the field is non-empty". Each one runs the PLANNER that reads the
 * field and asserts the decision it could not previously make — a field could otherwise be filled
 * with something the planner rejects and every assertion here would still pass.
 *
 * The other half is the part that must not regress: a field is filled only from what the beat
 * states. A beat that names no year still has no visualTime, and it must never gain a plausible
 * one.
 */
import { describe, expect, it } from "vitest";

import { intentFrom, type AdoptionFacts, type ProductionBeat } from "./cinematicPipelineInputs";
import { beatNamedEntitiesByKind } from "./videoPipeline";
import { planCaptions } from "./cinematicEditingEngine/captionPlanner";
import { planShot } from "./cinematicEditingEngine/shotPlanner";
import { planMotionGraphics } from "./cinematicEditingEngine/motionGraphicsPlanner";
import { extractActionCue } from "./videoPipeline";
import type { CandidateAsset } from "./visualMatchingV2/types";

/* ═══════════════════════ fixtures ═══════════════════════ */

function beat(text: string): ProductionBeat {
  return {
    index: 0,
    text,
    searchQuery: "beat query",
    powerWord: "Subject",
    keywords: ["subject"],
    holdSec: 4,
    visualDescription: "",
    voiceStartSec: 0,
    voiceEndSec: 4,
  };
}

const ADOPTION: AdoptionFacts = {
  provider: "internet_archive",
  providerAssetId: "abc",
  sourceUrl: "https://archive.invalid/a.mp4",
  query: "beat query",
};

/** The production extractors, exactly as videoPipeline injects them. */
const EXTRACTORS = {
  action: (t: string) => extractActionCue(t),
  namedEntities: (t: string) => beatNamedEntitiesByKind(t),
};

function intentOf(text: string) {
  return intentFrom(beat(text), 0, 0, ADOPTION, EXTRACTORS);
}

function candidate(over: Partial<CandidateAsset> = {}): CandidateAsset {
  return {
    id: "c1",
    source: "internet_archive",
    assetType: "video",
    url: "https://archive.invalid/a.mp4",
    title: "A clip",
    description: "",
    width: 1920,
    height: 1080,
    duration: 10,
    ...over,
  } as CandidateAsset;
}

/* ═══════════════════════ visualTime ═══════════════════════ */

describe("R177 — visualTime carries the period the beat states", () => {
  it("takes the fullest period, month included", () => {
    expect(intentOf("In April 1945 the bunker fell silent.").visualTime).toBe("April 1945");
  });

  it("takes the bare year when the beat names no month", () => {
    expect(intentOf("The war ended in 1945.").visualTime).toBe("1945");
  });

  /** The half that must not regress: no year stated means no year invented. */
  it("stays empty when the beat states no year at all", () => {
    expect(intentOf("The bunker fell silent.").visualTime).toBe("");
  });

  /**
   * The decision that was unreachable. A date card is what a viewer sees, and before R177 no
   * render could produce one because `visualTime` was always "".
   */
  it("makes the caption planner able to emit a date card at all", () => {
    const captions = planCaptions(intentOf("The war ended in 1945."), 0, 4);
    const date = captions.find((c) => c.captionType === "date" || c.captionType === "timeline_label");
    expect(date, "no dated caption — visualTime never reached the planner").toBeTruthy();
    expect(date!.text).toBe("1945");
  });

  it("and emits none for a beat with no date", () => {
    const captions = planCaptions(intentOf("The bunker fell silent."), 0, 4);
    expect(captions.filter((c) => c.captionType === "date")).toEqual([]);
  });
});

/* ═══════════════════════ events + historicalContext ═══════════════════════ */

describe("R177 — a named event reaches the planners as an event", () => {
  const HISTORICAL = "In April 1945 the Battle of Berlin reached the city centre.";

  it("names the event rather than the bare verb", () => {
    expect(intentOf(HISTORICAL).events[0]).toBe("Battle of Berlin");
  });

  /** Assembled from what the beat said — the event and the period, nothing added. */
  it("builds historicalContext out of the beat's own event and period", () => {
    const ctx = intentOf(HISTORICAL).historicalContext;
    expect(ctx).toContain("Battle of Berlin");
    expect(ctx).toContain("April 1945");
  });

  it("leaves historicalContext empty for a beat with no historical signal", () => {
    expect(intentOf("She opened the door and walked outside.").historicalContext).toBe("");
  });

  /**
   * The caption a dated historical beat should get: a timeline label carrying BOTH the year and
   * the event, rather than the plain date card. It needs all three fields at once, which is why it
   * was the least reachable rule of the set.
   */
  it("upgrades the date card to a timeline label with the event as subtitle", () => {
    const captions = planCaptions(intentOf(HISTORICAL), 0, 4);
    const label = captions.find((c) => c.captionType === "timeline_label");
    expect(label, "the timeline label rule is still unreachable").toBeTruthy();
    expect(label!.text).toBe("1945");
    expect(label!.subtitle).toBe("Battle of Berlin");
  });

  it("puts the same event on a timeline graphic", () => {
    const graphics = planMotionGraphics(intentOf(HISTORICAL), undefined, 0, 4);
    const timeline = graphics.find((g) => g.graphicType === "timeline");
    expect(timeline, "the timeline graphic rule is still unreachable").toBeTruthy();
  });

  /**
   * The archival shot rule. Both halves have to hold — the beat's context AND an archival source —
   * so the second assertion checks a stock candidate does NOT get the archival label.
   */
  it("lets the shot planner call an archival clip archive footage", () => {
    const shot = planShot(intentOf(HISTORICAL), candidate({ source: "internet_archive" }));
    expect(shot.shotType).toBe("archive_footage");
    expect(shot.reason).toContain("Battle of Berlin");
  });

  it("does not call a stock clip archive footage on the same beat", () => {
    const shot = planShot(intentOf(HISTORICAL), candidate({ source: "pexels" }));
    expect(shot.shotType).not.toBe("archive_footage");
  });
});

/* ═══════════════════════ objects ═══════════════════════ */

describe("R177 — the object the beat centres on", () => {
  it("comes from the beat's own words", () => {
    expect(intentOf("He held the pistol in his right hand.").objects).toEqual(["pistol"]);
  });

  it("is empty when the beat names no concrete object", () => {
    expect(intentOf("He thought about the decision for a long time.").objects).toEqual([]);
  });

  /** A named entity is more specific than a common noun, so it wins the slot. */
  it("prefers the named entity over the generic noun", () => {
    expect(intentOf("The Titanic was a ship of the White Star Line.").objects[0]).toBe("RMS Titanic");
  });

  it("makes the motion graphics planner able to draw a highlight box", () => {
    const graphics = planMotionGraphics(intentOf("He held the pistol in his right hand."), undefined, 0, 4);
    const highlight = graphics.find((g) => g.graphicType === "highlight_box");
    expect(highlight, "the highlight box rule is still unreachable").toBeTruthy();
    expect(JSON.stringify(highlight!.data)).toContain("pistol");
  });
});

/* ═══════════════════════ brands and companies ═══════════════════════ */

describe("R177 — named brands and companies, from the retrieval path's own table", () => {
  it("puts a company in companies", () => {
    expect(intentOf("Tesla opened a new plant this year.").companies).toContain("Tesla");
  });

  it("puts a product in brands", () => {
    expect(intentOf("The Cybertruck was unveiled to a packed hall.").brands).toContain("Cybertruck");
  });

  /**
   * The one that would be actively wrong. A person in that table must not become a brand — an
   * animated icon labelled "Elon Musk" is not a thing anyone asked for, and the person channel
   * already answers this question.
   */
  it("never offers a person as a brand or a company", () => {
    const intent = intentOf("Elon Musk walked onto the stage.");
    expect(intent.brands).toEqual([]);
    expect(intent.companies).toEqual([]);
  });

  it("makes the brand icon reachable, labelled with the entity's own name", () => {
    const graphics = planMotionGraphics(intentOf("Tesla opened a new plant this year."), undefined, 0, 4);
    const icon = graphics.find((g) => g.graphicType === "animated_icon");
    expect(icon, "the brand icon rule is still unreachable").toBeTruthy();
    expect(JSON.stringify(icon!.data)).toContain("Tesla");
  });

  it("stays empty for a beat naming no entity in the table", () => {
    const intent = intentOf("The river ran quietly past the town.");
    expect(intent.brands).toEqual([]);
    expect(intent.companies).toEqual([]);
  });
});

/* ═══════════════════════ nothing is invented ═══════════════════════ */

describe("R177 — the fields are evidence, not decoration", () => {
  /**
   * Every filled value has to appear in, or be derived from, the beat's own text. This is the
   * assertion that would fail if a future edit reached for the video title, the scene text, or a
   * default — the exact class of mistake the search contract exists to prevent, applied to the
   * plan instead of the query.
   */
  it("every filled term traces back to the beat's words", () => {
    const text = "In April 1945 the Battle of Berlin reached the city centre.";
    const intent = intentOf(text);
    const hay = text.toLowerCase();
    for (const term of [
      intent.visualTime,
      ...intent.events,
      ...intent.objects,
      ...intent.brands,
      ...intent.companies,
    ].filter(Boolean)) {
      const words = term.toLowerCase().split(/\s+/);
      expect(words.some((w) => hay.includes(w)), `"${term}" is in no word of the beat`).toBe(true);
    }
  });

  /** An extractor that is not injected must leave its field empty, never guess. */
  it("an absent extractor means an empty field, not a fallback answer", () => {
    const intent = intentFrom(beat("Tesla opened a new plant."), 0, 0, ADOPTION, {});
    expect(intent.brands).toEqual([]);
    expect(intent.companies).toEqual([]);
    expect(intent.secondaryVisualSubjects).toEqual([]);
  });

  /** Deterministic: the same beat plans the same way on every render (§32). */
  it("is deterministic for the same beat", () => {
    const text = "In April 1945 the Battle of Berlin reached the city centre.";
    expect(JSON.stringify(intentOf(text))).toBe(JSON.stringify(intentOf(text)));
  });
});
