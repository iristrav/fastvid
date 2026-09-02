/**
 * RONDE 157 §7/§8/§9 — the Director's vocabulary, with meanings attached.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────────────────────
 *
 * §7: "Niet alleen strings toevoegen." A shot type that is only a string is a label the planners
 * pass around and nobody can reason about. `SHOT_SEMANTICS` below says, for each one, what it is
 * FOR — what it shows, how close it is, and whether it can stand in for another. That turns a
 * union into something a variety policy can actually work with.
 *
 * It is an exhaustive `Record<ShotType, …>`, so adding a shot type without giving it a meaning is
 * a compile error rather than a gap someone finds in a render six weeks later.
 *
 * ── §8: variety must never beat relevance ───────────────────────────────────────────────────
 *
 * "inhoudelijke relevantie blijft belangrijker dan kunstmatige variatie."
 *
 * So `suggestVariedShot` returns a shot with the SAME semantic role wherever one exists — a wide
 * becomes an extreme wide or an establishing shot, never a detail. Breaking a run of four wides by
 * cutting to a close-up of nothing in particular is worse than the run: the run is monotonous, the
 * close-up is wrong. When no same-role alternative exists the function returns null and the run
 * stands, reported by the quality rules rather than papered over.
 *
 * ── Everything here is pure ─────────────────────────────────────────────────────────────────
 *
 * No randomness, no clock. §35's determinism rule reaches into the Director too: the same scene
 * must produce the same shot order every time, or two renders of one timeline disagree.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { ShotType } from "./cinematicEditingEngine/types";

/* ═══════════════════════ what each shot is for ═══════════════════════ */

/**
 * How much of the subject a shot holds. The ladder a cut moves along.
 *
 * Ordered, so "one step wider" and "two steps closer" are arithmetic rather than a lookup table.
 */
export type ShotScale = "extreme_wide" | "wide" | "medium" | "close" | "extreme_close";

export const SHOT_SCALE_ORDER: readonly ShotScale[] = [
  "extreme_wide",
  "wide",
  "medium",
  "close",
  "extreme_close",
];

/**
 * What a shot is doing in the edit, as opposed to how close it is.
 *
 * This is the axis that matters for §8: two shots with the same ROLE are interchangeable for
 * variety purposes, and two with different roles are not, however similar their scale.
 */
export type ShotRole =
  | "orientation"
  | "subject"
  | "detail"
  | "context"
  | "human_response"
  | "supporting"
  | "graphic";

export type ShotSemantics = {
  scale: ShotScale;
  role: ShotRole;
  /** What this shot is FOR, in one sentence. §7 asks for exactly this. */
  meaning: string;
  /**
   * Does this shot need footage of a particular kind that a stock pool may not have?
   *
   * An aerial is not a wide shot from a tripod, and asking for one when the pool holds none means
   * the beat gets something that is not what was planned. Marked so a planner can prefer a shot it
   * can actually fill.
   */
  needsSpecialFootage: boolean;
  /**
   * HOW TO ASK A PROVIDER FOR THIS FRAMING.
   *
   * ── Why the vocabulary needed this ──────────────────────────────────────────────────────────
   *
   * Every part of the shot vocabulary existed except the part that asks. A beat's planned shot was
   * derived, stored on the contract, weighed at 10% during ranking — and never once sent to a
   * provider. So the ranking could only prefer a close-up if a close-up happened to be in the pool
   * by luck, and on a documentary that means twenty-three variations of the same middle distance.
   *
   * ── Why these words and not the planner's own ───────────────────────────────────────────────
   *
   * Every term here is made of words already in `PRODUCTION_VOCABULARY` — the search gate's closed
   * class of camera and format words, allowed without evidence because they describe the FILM
   * rather than making a claim about the world. That is what makes these safe to append: a query
   * built from a proven anchor plus these words cannot be refused for the shot part of it.
   *
   * The LLM storyboard planner writes its own free-text `searchQuery` per shot, and that is
   * exactly what the gate refuses — 277 `UNVERIFIED_TERM` refusals on render 564. Words invented
   * for a beat cannot be proven by it. These can, because they claim nothing.
   *
   * `subjectSearchTerms.test.ts` asserts that property for every entry, so a term that the gate
   * would refuse cannot be added here without a test going red.
   *
   * Empty is a legitimate answer: some framings have no phrasing a stock or archive search
   * understands, and inventing one would spend a query slot on a guess.
   */
  searchTerms: readonly string[];
};

export const SHOT_SEMANTICS: Readonly<Record<ShotType, ShotSemantics>> = {
  establishing: {
    scale: "wide",
    role: "orientation",
    meaning: "Opens a scene by telling the viewer where they are before anything else happens.",
    needsSpecialFootage: false,
    searchTerms: ["establishing shot"],
  },
  extreme_wide: {
    scale: "extreme_wide",
    role: "context",
    meaning: "Places the subject inside a much larger space — scale, isolation, geography.",
    needsSpecialFootage: false,
    searchTerms: ["wide shot"],
  },
  wide: {
    scale: "wide",
    role: "context",
    meaning: "Shows the environment around the subject and how they relate to it.",
    needsSpecialFootage: false,
    searchTerms: ["wide shot"],
  },
  medium_wide: {
    scale: "wide",
    role: "subject",
    meaning: "Holds the subject and enough surroundings to keep them situated.",
    needsSpecialFootage: false,
    searchTerms: ["wide shot"],
  },
  medium: {
    scale: "medium",
    role: "subject",
    meaning: "The neutral distance: the subject at a natural, conversational scale.",
    needsSpecialFootage: false,
    /**
     * Deliberately empty, and the reason is editorial rather than technical.
     *
     * A medium shot is what a provider returns by default: asking for one narrows nothing and
     * spends a slot in a capped query family on a word that changes no result. It is also the
     * framing the fallback storyboard assigns to every beat when the planner is unavailable, so
     * emitting a term here would put one identical extra query on every beat of a video whose
     * shots were never actually planned — noise wearing the costume of intent.
     *
     * The rule this follows: ask for a framing only when it differs from what you would get
     * anyway.
     */
    searchTerms: [],
  },
  close_up: {
    scale: "close",
    role: "subject",
    meaning: "Draws attention to a face or a subject's expression.",
    needsSpecialFootage: false,
    searchTerms: ["closeup", "close-up"],
  },
  extreme_close_up: {
    scale: "extreme_close",
    role: "detail",
    meaning: "Isolates one small thing for maximum emphasis — an eye, a word, a switch.",
    needsSpecialFootage: false,
    searchTerms: ["closeup"],
  },
  detail: {
    scale: "close",
    role: "detail",
    meaning: "Shows a specific object, document, hand or action closely enough to read it.",
    needsSpecialFootage: false,
    searchTerms: ["closeup"],
  },
  overhead: {
    scale: "medium",
    role: "detail",
    /** Deliberately distinguished from `aerial` — see the note on the union. */
    meaning: "Looks straight DOWN at a surface: a table, a map, a process, a set of objects.",
    needsSpecialFootage: true,
    searchTerms: ["overhead", "topdown"],
  },
  aerial: {
    scale: "extreme_wide",
    role: "context",
    meaning: "Looks ACROSS a landscape from height — geography, scale, a place from above.",
    needsSpecialFootage: true,
    searchTerms: ["aerial"],
  },
  pov: {
    scale: "medium",
    role: "subject",
    meaning: "The subject's own view: what they are looking at, from where they stand.",
    needsSpecialFootage: true,
    searchTerms: [],
  },
  reaction: {
    scale: "close",
    role: "human_response",
    meaning: "Shows how somebody responds, adding a human dimension to a fact.",
    needsSpecialFootage: false,
    searchTerms: [],
  },
  cutaway: {
    scale: "medium",
    role: "supporting",
    meaning: "Bridges the narration with related coverage while the voice carries on.",
    needsSpecialFootage: false,
    searchTerms: ["cutaway"],
  },
  b_roll: {
    scale: "medium",
    role: "supporting",
    meaning: "General supporting coverage of the topic, under narration.",
    needsSpecialFootage: false,
    searchTerms: ["b-roll"],
  },
  archive_footage: {
    scale: "medium",
    role: "supporting",
    meaning: "Grounds the moment in real historical material rather than a modern re-creation.",
    needsSpecialFootage: true,
    searchTerms: ["archival footage", "newsreel"],
  },
  overlay_shot: {
    scale: "medium",
    role: "graphic",
    meaning: "Carries a graphic — a map, a chart, a timeline — rather than a literal photograph.",
    needsSpecialFootage: false,
    searchTerms: [],
  },
};

/** Every shot type, as a list. Derived from the semantics so the two can never disagree. */
export const ALL_SHOT_TYPES = Object.keys(SHOT_SEMANTICS) as ShotType[];

/** How far apart two shots are on the scale ladder. 0 means the same framing. */
export function scaleDistance(a: ShotType, b: ShotType): number {
  return Math.abs(
    SHOT_SCALE_ORDER.indexOf(SHOT_SEMANTICS[a].scale) -
      SHOT_SCALE_ORDER.indexOf(SHOT_SEMANTICS[b].scale)
  );
}

/* ═══════════════════════ §8 — the variety policy ═══════════════════════ */

/**
 * A run of this many identical shots is where an edit starts to feel stuck.
 *
 * Two is a normal cut between two angles of one subject. Three is where the viewer notices. The
 * same number `directorQualityRules` reports on, and deliberately so: the policy that AVOIDS a
 * problem and the rule that REPORTS it should not disagree about what the problem is.
 */
export const MAX_RUN_BEFORE_VARIETY = 2;

/**
 * A different shot for a beat that would otherwise repeat, or null to leave it alone.
 *
 * ── The rule that shapes this ───────────────────────────────────────────────────────────────
 *
 * §8: relevance beats variety. So the replacement must have the SAME ROLE — a context shot becomes
 * another context shot, a detail becomes another detail. A wide that becomes a close-up to avoid
 * monotony is a shot of the wrong thing, and a wrong shot is worse than a repeated one.
 *
 * `avoidSpecialFootage` defaults true because a pool that has four wides is unlikely to have an
 * aerial: suggesting one produces a beat the retrieval cannot fill, which lands back on whatever
 * it could find. A planner that knows its pool can pass false.
 *
 * Deterministic: the candidates are sorted and the choice is by index, so the same run always
 * produces the same alternative.
 */
export function suggestVariedShot(
  repeated: ShotType,
  recent: readonly ShotType[],
  opts: { avoidSpecialFootage?: boolean; index?: number } = {}
): { shotType: ShotType; reason: string } | null {
  const avoidSpecial = opts.avoidSpecialFootage !== false;
  const role = SHOT_SEMANTICS[repeated].role;

  const alternatives = ALL_SHOT_TYPES.filter((t) => {
    if (t === repeated) return false;
    if (SHOT_SEMANTICS[t].role !== role) return false;
    if (avoidSpecial && SHOT_SEMANTICS[t].needsSpecialFootage) return false;
    /** Something used in the last two beats is not variety either. */
    if (recent.slice(-2).includes(t)) return false;
    return true;
  }).sort((a, b) => {
    /**
     * Prefer the SMALLEST change in framing that is still a change.
     *
     * A wide becoming an extreme wide keeps the sequence coherent; a wide becoming a close-up
     * inside the same role would be a jump the narration did not ask for.
     */
    const da = scaleDistance(repeated, a);
    const db = scaleDistance(repeated, b);
    return da - db || a.localeCompare(b);
  });

  const chosen = alternatives[Math.abs(opts.index ?? 0) % Math.max(1, alternatives.length)];
  if (!chosen) return null;

  return {
    shotType: chosen,
    reason:
      `${repeated} has run for ${MAX_RUN_BEFORE_VARIETY + 1} beats; ${chosen} keeps the same ` +
      `editorial role (${role}) while changing the framing`,
  };
}

/**
 * Apply the variety policy across a whole scene's planned shots.
 *
 * Returns the shots WITH their reasons, so a caller can see which ones the policy touched and
 * why — §"Geen blind randomization" made auditable.
 */
export function applyShotVariety(
  planned: readonly ShotType[],
  opts: { avoidSpecialFootage?: boolean } = {}
): Array<{ shotType: ShotType; changed: boolean; reason: string | null }> {
  const out: Array<{ shotType: ShotType; changed: boolean; reason: string | null }> = [];
  let run = 0;

  for (let i = 0; i < planned.length; i++) {
    const want = planned[i]!;
    const previous = out[i - 1]?.shotType;
    run = previous === want ? run + 1 : 0;

    if (run < MAX_RUN_BEFORE_VARIETY) {
      out.push({ shotType: want, changed: false, reason: null });
      continue;
    }

    const varied = suggestVariedShot(
      want,
      out.map((o) => o.shotType),
      { ...opts, index: i }
    );
    if (!varied) {
      /** No same-role alternative. The run stands and the quality rules will report it. */
      out.push({ shotType: want, changed: false, reason: null });
      continue;
    }
    out.push({ shotType: varied.shotType, changed: true, reason: varied.reason });
    run = 0;
  }

  return out;
}

/* ═══════════════════════ §9 — attention moments ═══════════════════════ */

/**
 * A moment the Director wants the viewer to notice, and why.
 *
 * §9 asks for these to be FIRST-CLASS: a named thing the planners can react to, rather than an
 * energy number that every stage interprets differently.
 */
export type AttentionMoment =
  | "hook"
  | "reveal"
  | "impact"
  | "emphasis"
  | "turning_point"
  | "statistic"
  | "quote"
  | "location"
  | "climax";

/**
 * What one attention moment MAY influence.
 *
 * "May" is the operative word, and the reason this is data rather than code. §9's last line is
 * "alleen wanneer de benodigde payload bestaat. Geen nep-data genereren." A `statistic` moment
 * suggests a statistic graphic — but only if the beat actually has a number in it. This table says
 * what is appropriate; the planner still has to check that it is possible.
 */
export type AttentionEffect = {
  /** The shot this moment argues for, when the footage allows it. */
  preferShot: ShotType | null;
  /** Whether the cut should be shorter than the pacing would otherwise give it. */
  tightenCut: boolean;
  /** A camera move that suits the moment, or null to leave the camera alone. */
  camera: "slow_push" | "slow_pull" | "camera_hold" | null;
  /** A caption treatment. Only applied when the beat has words to treat. */
  captionEmphasis: boolean;
  /** A graphic type this moment suggests, IF the payload for it exists. */
  suggestsGraphic: string | null;
  /** A sound accent, IF the catalog actually holds one. */
  suggestsSfx: string | null;
  why: string;
};

export const ATTENTION_EFFECTS: Readonly<Record<AttentionMoment, AttentionEffect>> = {
  hook: {
    preferShot: "detail",
    tightenCut: true,
    camera: "slow_push",
    captionEmphasis: true,
    suggestsGraphic: null,
    suggestsSfx: "impact",
    why: "The opening seconds decide whether the video is watched at all.",
  },
  reveal: {
    preferShot: "close_up",
    tightenCut: false,
    camera: "slow_push",
    captionEmphasis: true,
    suggestsGraphic: null,
    suggestsSfx: null,
    why: "A reveal wants the viewer to look closer as the information lands.",
  },
  impact: {
    preferShot: "extreme_close_up",
    tightenCut: true,
    camera: "camera_hold",
    captionEmphasis: true,
    suggestsGraphic: null,
    suggestsSfx: "impact",
    why: "A hard fact lands harder on a held frame than on a moving one.",
  },
  emphasis: {
    preferShot: null,
    tightenCut: false,
    camera: null,
    captionEmphasis: true,
    suggestsGraphic: null,
    suggestsSfx: null,
    why: "The words carry this moment; the picture should not compete with them.",
  },
  turning_point: {
    preferShot: "wide",
    tightenCut: false,
    camera: "slow_pull",
    captionEmphasis: false,
    suggestsGraphic: null,
    suggestsSfx: null,
    why: "Pulling out at a turn shows the viewer the situation has changed shape.",
  },
  statistic: {
    preferShot: "overlay_shot",
    tightenCut: false,
    camera: "camera_hold",
    captionEmphasis: false,
    /** ONLY if the beat carries real numbers — see the note on this table. */
    suggestsGraphic: "statistic",
    suggestsSfx: null,
    why: "A number is read, not watched: it wants a still frame and a graphic.",
  },
  quote: {
    preferShot: "overlay_shot",
    tightenCut: false,
    camera: "camera_hold",
    captionEmphasis: false,
    suggestsGraphic: "quote",
    suggestsSfx: null,
    why: "A quotation belongs on screen in the speaker's own words.",
  },
  location: {
    preferShot: "establishing",
    tightenCut: false,
    camera: null,
    captionEmphasis: false,
    suggestsGraphic: "location_card",
    suggestsSfx: null,
    why: "Naming a place is only useful if the viewer can also see it.",
  },
  climax: {
    preferShot: "extreme_wide",
    tightenCut: false,
    camera: "slow_pull",
    captionEmphasis: true,
    suggestsGraphic: null,
    suggestsSfx: "impact",
    why: "The biggest moment wants the biggest frame.",
  },
};

/**
 * Which attention moment a beat is, from evidence in the beat itself.
 *
 * ── Why this reads the text rather than being told ──────────────────────────────────────────
 *
 * §11: "De beslissing moet uit de inhoud volgen." A hook is not "the first beat" — it is a beat in
 * the opening that has something worth hooking on. So position is necessary and never sufficient:
 * `hook` is only returned for an early beat that ALSO carries a number, a name or a question.
 *
 * Returns null far more often than not, which is correct. Most beats are not attention moments, and
 * a Director that marked every beat as one would be marking none.
 */
export function classifyAttentionMoment(params: {
  text: string;
  beatIndexInVideo: number;
  videoDurationSec: number;
  beatStartSec: number;
  /** Does this beat's intent name a place? Supplied by the caller — this does not extract. */
  hasLocation?: boolean;
}): { moment: AttentionMoment; evidence: string } | null {
  const text = params.text.trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  /** A real number with weight — a year, a count, a percentage. Not "one" or "a couple". */
  const numberMatch = text.match(/\b\d[\d,.]*\s*(%|percent|million|billion|thousand)?\b/i);
  const hasBigNumber = Boolean(numberMatch);
  const isQuote = /["“”].{8,}["“”]/.test(text) || /\b(said|wrote|declared|put it)\b/i.test(lower);

  /**
   * The hook window. 12 seconds rather than the Director's 30-second hook window: a hook SHOT is a
   * narrower thing than a hook SEGMENT, and by 30 seconds a viewer who stayed is already watching.
   */
  const inOpening = params.beatStartSec <= 12 && params.beatIndexInVideo <= 3;

  if (inOpening && (hasBigNumber || isQuote || lower.includes("?"))) {
    return {
      moment: "hook",
      evidence: hasBigNumber
        ? `opens with a number ("${numberMatch![0].trim()}")`
        : isQuote
          ? "opens with a quotation"
          : "opens with a question",
    };
  }
  if (isQuote) return { moment: "quote", evidence: "the beat quotes somebody" };
  if (hasBigNumber) {
    return { moment: "statistic", evidence: `the beat states a figure ("${numberMatch![0].trim()}")` };
  }
  if (params.hasLocation) return { moment: "location", evidence: "the beat names a place" };
  if (/\b(but|however|until|then everything|changed|suddenly)\b/i.test(lower)) {
    return { moment: "turning_point", evidence: "the narration turns here" };
  }
  return null;
}

/** One line per attention moment, for the render log. */
export function formatAttentionMoment(
  beatId: string,
  found: { moment: AttentionMoment; evidence: string }
): string {
  return (
    `[Director] attention ${found.moment} at ${beatId} — ${found.evidence}; ` +
    ATTENTION_EFFECTS[found.moment].why
  );
}

/* ═══════════════════════ the planned shot, where the search can reach it ═══════════════════════ */

/**
 * THE FRAMING THIS BEAT WAS PLANNED FOR, available to whatever ends up asking a provider.
 *
 * ── Why ambient and not a parameter ─────────────────────────────────────────────────────────
 *
 * `buildHistoricalArchivalQueries` is reached from five call sites, each fed by one of eight
 * `buildMediaSearchIntent` calls, and the beat's planned shot is known at none of them — it is
 * established by the storyboard planner, scenes earlier in the file. Threading it through thirteen
 * signatures is precisely the seam this codebase keeps being bitten by: a fact several routes must
 * remember, remembered by one. `recordClipAdopt`, the still/moving counters, the beat verdicts and
 * the source floor were all that shape, and all were fixed this way.
 *
 * It sits beside `searchProvenanceStorage` in spirit and for the same reason: scenes are sourced
 * concurrently, so a mutable per-render field would let one beat's framing shape another beat's
 * query.
 *
 * ── What a missing scope means ──────────────────────────────────────────────────────────────
 *
 * Nothing. Absent means "no framing was planned for this beat", the query keeps exactly the shape
 * it had before this existed, and no route is worse off than it was. A planned shot is a preference
 * the search may express, never a requirement it must satisfy.
 */
const plannedShotStorage = new AsyncLocalStorage<ShotType>();

/** The framing planned for the beat currently being sourced, or undefined outside any beat scope. */
export function getPlannedShot(): ShotType | undefined {
  return plannedShotStorage.getStore();
}

/** Run `fn` with `shotType` as the ambient framing for every provider query it builds. */
export function withPlannedShot<T>(shotType: ShotType | null | undefined, fn: () => T): T {
  return shotType ? plannedShotStorage.run(shotType, fn) : fn();
}

/**
 * A planner's loose wording for a framing, as a member of this vocabulary — or null.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────────────────────
 *
 * The storyboard's `shotType` is a bare string an LLM wrote. It says "medium shot", "close up",
 * "Wide Shot"; the union spells those `medium`, `close_up`, `wide`. Every reader that wanted the
 * planned framing had to do its own comparison, and `assetDirector` still does one by hand
 * (`shotType.includes(planned.split(" ")[0])`), which matches "wide" against "wide" and also
 * against nothing else it should.
 *
 * Recognition lives HERE, next to the vocabulary being recognised, so there is one answer to
 * "which framing did the planner mean" rather than one per reader.
 *
 * Anything unrecognised returns null. Guessing at the nearest match would hand a beat a framing
 * nobody planned, and asking for nothing is the honest response to wording this vocabulary does
 * not contain.
 */
export function normaliseShotType(loose: string | null | undefined): ShotType | null {
  if (!loose) return null;
  const raw = loose.trim().toLowerCase().replace(/[\s-]+/g, "_");
  /**
   * The raw spelling is tried FIRST, before the `_shot` suffix is dropped.
   *
   * `overlay_shot` is a member of this union whose name ENDS in the suffix, so stripping first
   * turned the vocabulary's own spelling into `overlay`, which is not a framing at all — the one
   * shot type that could not be recognised was the one written exactly as the union spells it.
   */
  if (raw in SHOT_SEMANTICS) return raw as ShotType;
  const key = raw.replace(/_shot$/, "");
  if (key in SHOT_SEMANTICS) return key as ShotType;
  /** "close" and "closeup" both mean close_up; the planner uses either. */
  const aliases: Readonly<Record<string, ShotType>> = {
    close: "close_up",
    closeup: "close_up",
    extreme_close: "extreme_close_up",
    extreme_closeup: "extreme_close_up",
    establishing_wide: "establishing",
    insert: "detail",
    macro: "extreme_close_up",
    drone: "aerial",
    birds_eye: "overhead",
    top_down: "overhead",
    topdown: "overhead",
    archive: "archive_footage",
    archival: "archive_footage",
    b_roll_shot: "b_roll",
    broll: "b_roll",
  };
  return aliases[key] ?? null;
}

/**
 * The words that ask for a framing, or an empty list.
 *
 * Accepts the planner's loose wording as well as a union member, because every caller has the
 * former and none of them should have to know how to turn it into the latter.
 */
export function shotSearchTerms(shotType: string | null | undefined): readonly string[] {
  const known = normaliseShotType(shotType);
  return known ? SHOT_SEMANTICS[known].searchTerms : [];
}
